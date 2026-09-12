import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { createMemoryMap } from "../persistence/durable-map.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { nonInteractiveShellPrefix, DROPPED_PROXY_ENV } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  posixJoin,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import {
  ephemeralCredLinkScript,
  ephemeralCredLinkPaths,
  type CredentialPathSpec,
} from "../credentials/resident-paths.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { sandboxScopeName } from "./exec-sandbox-base.ts";
import {
  SuperserveSandboxGoneError,
  type SuperserveClient,
  type SuperserveNetwork,
  type SuperserveSession,
} from "./superserve-client.ts";
import type {
  AgentComputerProfile,
  ComputerStatus,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

const DEFAULT_HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const DEFAULT_IDLE_PAUSE_SEC = 15 * 60;
const DEFAULT_RETENTION_SEC = 30 * 24 * 3600;
const SCRATCH_IDLE_PAUSE_SEC = 10 * 60;
const PREP_TIMEOUT_SEC = 60;
const TIMEOUT_EXIT_CODE = 124;

export const SUPERSERVE_METADATA = {
  scope: "qm_scope",
  prefix: "qm_prefix",
  kind: "qm_kind",
} as const;

export interface StoredSuperserveSandbox {
  sandboxId: string;
  createdAtMs: number;
  lifecycle?: "running" | "paused" | "pause_failed";
  preservationError?: string;
  homeDir?: string;
}

export interface SuperserveSandboxOptions extends BlobStagingOptions {
  client: SuperserveClient;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  template?: string;
  homeDir?: string;
  idlePauseSec?: number;
  retentionSec?: number;
  egressAllow?: string[];
  egressDeny?: string[];
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  store?: DurableMap<StoredSuperserveSandbox>;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

interface Live {
  session: SuperserveSession;
  homeDir: string;
}

export function createSuperserveSandbox(workspace: WorkspaceStore, opts: SuperserveSandboxOptions): Sandbox {
  const client = opts.client;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const configuredHome = opts.homeDir ?? DEFAULT_HOME_DIR;
  const idlePauseSec = opts.idlePauseSec ?? DEFAULT_IDLE_PAUSE_SEC;
  const retentionSec = opts.retentionSec ?? DEFAULT_RETENTION_SEC;
  const network: SuperserveNetwork | undefined =
    opts.egressAllow?.length || opts.egressDeny?.length
      ? {
          ...(opts.egressAllow?.length ? { allowOut: opts.egressAllow } : {}),
          ...(opts.egressDeny?.length ? { denyOut: opts.egressDeny } : {}),
        }
      : undefined;
  const store = opts.store ?? createMemoryMap<StoredSuperserveSandbox>();
  const provisionQueue = createKeyedQueue<string>();

  const liveByName = new Map<string, Live>();
  const scopeByName = new Map<string, string>();
  const scratchKeyByName = new Map<string, string>();
  const activeScratch = new Map<string, number>();

  const reportError = (category: string, code: string, message: string, scopeLabel?: string): void => {
    opts.onError?.({ category, code, message, ...(scopeLabel ? { scopeLabel } : {}) });
  };

  const workspaceDirOf = (homeDir: string): string => `${homeDir}/${WORKSPACE_BASENAME}`;

  const scopeMetadata = (name: string): Record<string, string> => ({
    [SUPERSERVE_METADATA.scope]: name,
    [SUPERSERVE_METADATA.prefix]: prefix,
    [SUPERSERVE_METADATA.kind]: "scope",
  });

  // The template decides the login user, so the home directory is discovered
  // once per live session rather than assumed.
  async function detectHome(session: SuperserveSession): Promise<string> {
    const r = await session.run('printf %s "${HOME:-}"', { timeoutMs: 30_000 });
    const home = r.exitCode === 0 ? r.stdout.trim() : "";
    return home.startsWith("/") ? home : configuredHome;
  }

  async function adopt(name: string, session: SuperserveSession, knownHome?: string): Promise<Live> {
    const homeDir = knownHome ?? (await detectHome(session));
    const live: Live = { session, homeDir };
    liveByName.set(name, live);
    return live;
  }

  async function ensureLive(
    scope: string,
    name: string,
    onStatus?: (text: string) => void,
  ): Promise<{ live: Live; coldStart: boolean }> {
    return provisionQueue(scope, async () => {
      const cached = liveByName.get(name);
      if (cached) return { live: cached, coldStart: false };

      const stored = await store.get(scope);
      if (stored) {
        try {
          const session = await client.connect(stored.sandboxId);
          const live = await adopt(name, session, stored.homeDir);
          await store.merge(scope, { lifecycle: "running", preservationError: undefined, homeDir: live.homeDir });
          return { live, coldStart: false };
        } catch (err) {
          if (!(err instanceof SuperserveSandboxGoneError)) throw err;
          await store.delete(scope);
        }
      }

      // A core restart without durable storage, or a lost record: the sandbox
      // itself is the source of truth, found by its scope metadata.
      const listed = await client.list({ [SUPERSERVE_METADATA.scope]: name });
      for (const summary of listed) {
        try {
          const session = await client.connect(summary.id);
          const live = await adopt(name, session);
          await store.put(scope, {
            sandboxId: session.id,
            createdAtMs: Date.now(),
            lifecycle: "running",
            homeDir: live.homeDir,
          });
          return { live, coldStart: false };
        } catch (err) {
          if (!(err instanceof SuperserveSandboxGoneError)) throw err;
        }
      }

      try {
        onStatus?.("Creating the sandbox…");
      } catch (error) {
        void error;
      }
      const session = await client.create({
        name,
        metadata: scopeMetadata(name),
        ...(opts.template ? { template: opts.template } : {}),
        timeoutSeconds: idlePauseSec,
        autoDeleteSeconds: retentionSec,
        ...(network ? { network } : {}),
      });
      const live = await adopt(name, session);
      await store.put(scope, {
        sandboxId: session.id,
        createdAtMs: Date.now(),
        lifecycle: "running",
        homeDir: live.homeDir,
      });
      return { live, coldStart: true };
    });
  }

  async function createScratch(name: string): Promise<Live> {
    const session = await client.create({
      name,
      metadata: { ...scopeMetadata(name), [SUPERSERVE_METADATA.kind]: "scratch" },
      ...(opts.template ? { template: opts.template } : {}),
      timeoutSeconds: SCRATCH_IDLE_PAUSE_SEC,
      autoDeleteSeconds: 0,
      ...(network ? { network } : {}),
    });
    return adopt(name, session);
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    const name = sandboxScopeName(`${prefix}-scratch`, key);
    return provisionQueue(`scratch:${key}`, async () => {
      scratchKeyByName.set(name, key);
      const active = activeScratch.get(name) ?? 0;
      if (active === 0 && !liveByName.has(name)) await createScratch(name);
      activeScratch.set(name, active + 1);
      return { name, coldStart: active === 0 };
    });
  }

  async function withLive<T>(name: string, action: (live: Live) => Promise<T>): Promise<T> {
    const scratchKey = scratchKeyByName.get(name);
    const acquire = async (): Promise<Live> =>
      scratchKey !== undefined
        ? (liveByName.get(name) ?? (await createScratch(name)))
        : (await ensureLive(scopeByName.get(name) ?? "default", name)).live;
    try {
      return await action(await acquire());
    } catch (err) {
      if (!(err instanceof SuperserveSandboxGoneError)) throw err;
      liveByName.delete(name);
      return action(await acquire());
    }
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    return withLive(name, async ({ session }) => {
      const r = await session.run(`timeout ${timeoutSec} sh -c ${shq(script)}`, {
        timeoutMs: timeoutSec * 1000 + 30_000,
      });
      const stderr = r.truncated ? `${r.stderr}\n[superserve: output truncated by the sandbox host]` : r.stderr;
      return { stdout: r.stdout, stderr, code: r.exitCode, timedOut: r.exitCode === TIMEOUT_EXIT_CODE };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "superserve",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Ubuntu — Superserve Firecracker microVM (disk persists across pause/resume; publish durable work to git or Files)",
      runtimes: ["Node", "Python 3"],
      get tools() {
        return visibleTools(["git", "curl", "jq", "tar", "python3", ...(opts.extraTools ?? [])]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gh", "aws", "gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      homeDir: configuredHome,
      workdir: workspaceDirOf(configuredHome),
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const writeAbsBytes = (name: string, absPath: string, data: Uint8Array): Promise<void> =>
    withLive(name, ({ session }) => session.writeFileBytes(absPath, data));
  const readAbsBytes = (name: string, absPath: string): Promise<Uint8Array | null> =>
    withLive(name, ({ session }) => session.readFileBytes(absPath));
  const installLayerTools = opts.layerToolFiles ? createLayerToolInstaller(opts.layerToolFiles) : null;

  const execFileOps = createExecFileOps({
    label: "superserve",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execExport = createExecExport({
    label: "superserve",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: configuredHome,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  const blobStaging = createBackendBlobStaging("superserve", (id, script, t) => execRaw(id, script, t), opts);

  async function destroyStoredScope(scope: string): Promise<void> {
    const name = sandboxScopeName(prefix, scope);
    const stored = await store.get(scope);
    const cached = liveByName.get(name);
    const ids = new Set([stored?.sandboxId, cached?.session.id].filter((id): id is string => !!id));
    const listed = await client.list({ [SUPERSERVE_METADATA.scope]: name }).catch(swallowAs("superserve: list", []));
    for (const summary of listed) ids.add(summary.id);
    for (const id of ids) {
      try {
        await client.kill(id);
      } catch (error) {
        if (!(error instanceof SuperserveSandboxGoneError)) throw error;
      }
    }
    await store.delete(scope);
    liveByName.delete(name);
    scopeByName.delete(name);
  }

  const sandbox: Sandbox = {
    destroyScope(scopeId: string): Promise<void> {
      return provisionQueue(scopeId, () => destroyStoredScope(scopeId));
    },

    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,
    ...blobStaging,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      let name: string;
      let coldStart: boolean;
      let homeDir: string;
      if (scratch) {
        ({ name, coldStart } = await ensureScratch(scratch.key));
        homeDir = liveByName.get(name)?.homeDir ?? configuredHome;
      } else {
        name = sandboxScopeName(prefix, scope);
        scopeByName.set(name, scope);
        const ensured = await ensureLive(scope, name, provOpts?.onStatus);
        coldStart = ensured.coldStart;
        homeDir = ensured.live.homeDir;
      }
      const workspaceDir = workspaceDirOf(homeDir);

      const env = Object.fromEntries(Object.entries(provOpts?.env ?? {}).filter(([k]) => !DROPPED_PROXY_ENV.has(k)));
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir,
        coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      };

      try {
        const credLinks = scratch ? "" : ` && ${ephemeralCredLinkScript(homeDir, opts.credentialPaths ?? [])}`;
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)}${credLinks}`, PREP_TIMEOUT_SEC);
        if (prep.code !== 0)
          throw new Error(`superserve provision prep failed: ${(prep.stderr || prep.stdout).slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "superserve" },
        );
        await installLayerTools?.({
          exec: (script, t) => execRaw(name, script, t),
          writeAbs: (abs, data) => writeAbsBytes(name, abs, data),
        });

        return handle;
      } catch (err) {
        await sandbox
          .teardown(handle)
          .catch(swallowAs("superserve-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(
          swallowAs("superserve-sandbox: kill in-flight exec", undefined),
        );
      };
      signal.throwIfAborted();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    exportFiles: execExport.exportFiles,

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const stored = await store.get(scopeId);
      if (!stored) return { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      const machine = `superserve sandbox ${stored.sandboxId}`;
      const recovery = {
        strategy: "provider_pause" as const,
        state: stored.lifecycle,
        ...(stored.preservationError ? { error: stored.preservationError } : {}),
      };
      try {
        const info = await client.info(stored.sandboxId);
        if (info.status === "paused" || info.status === "pausing")
          return {
            machine,
            listed: info.status,
            lifecycleState: "paused",
            provisioned: true,
            guestResponsive: false,
            recovery: { ...recovery, state: info.status, checkpointExpiresAtMs: info.autoDeleteAtMs ?? null },
          };
        scopeByName.set(name, scopeId);
        const { live } = await ensureLive(scopeId, name);
        const r = await live.session.run("echo responsive", { timeoutMs: 30_000 });
        return {
          machine,
          listed: info.status,
          lifecycleState: "running",
          recovery,
          provisioned: true,
          guestResponsive: r.exitCode === 0 && /responsive/.test(r.stdout),
        };
      } catch (e) {
        return {
          recovery,
          machine: `${machine} (${errMessage(e).slice(0, 120)})`,
          provisioned: !(e instanceof SuperserveSandboxGoneError),
          guestResponsive: false,
        };
      }
    },

    async restartComputer(scopeId: string): Promise<void> {
      const name = sandboxScopeName(prefix, scopeId);
      await provisionQueue(scopeId, async () => {
        const live = liveByName.get(name);
        liveByName.delete(name);
        if (live) {
          await live.session.pause().catch(swallowAs("superserve-sandbox: pause before restart", undefined));
        }
      });
      scopeByName.set(name, scopeId);
      await ensureLive(scopeId, name);
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (handle.scratch) {
        const key = scratchKeyByName.get(handle.id);
        return provisionQueue(key ? `scratch:${key}` : handle.id, async () => {
          const remaining = (activeScratch.get(handle.id) ?? 1) - 1;
          if (remaining > 0) {
            activeScratch.set(handle.id, remaining);
            return;
          }
          activeScratch.delete(handle.id);
          const live = liveByName.get(handle.id);
          liveByName.delete(handle.id);
          if (live) await live.session.kill().catch(swallowAs("superserve-sandbox: scratch kill", undefined));
        });
      }
      if (tdOpts?.destroy && !scopeByName.has(handle.id)) return;
      const scope = scopeByName.get(handle.id) ?? "default";
      return provisionQueue(scope, () => teardownScope(handle, scope, tdOpts));
    },
  };

  async function teardownScope(handle: SandboxHandle, scope: string, tdOpts?: TeardownOptions): Promise<void> {
    if (tdOpts?.destroy) return destroyStoredScope(scope);
    const live = liveByName.get(handle.id);
    if (!live || tdOpts?.keepWarm) return;
    try {
      await live.session.pause();
      await store.merge(scope, { lifecycle: "paused", preservationError: undefined });
      liveByName.delete(handle.id);
    } catch (error) {
      if (error instanceof SuperserveSandboxGoneError) {
        liveByName.delete(handle.id);
        await store.delete(scope);
        reportError("sandbox_preservation", "sandbox_gone", errMessage(error), scope);
        return;
      }
      await store.merge(scope, { lifecycle: "pause_failed", preservationError: errMessage(error) });
      reportError("sandbox_preservation", "pause_failed", errMessage(error), scope);
      throw error;
    }
  }

  return sandbox;
}
