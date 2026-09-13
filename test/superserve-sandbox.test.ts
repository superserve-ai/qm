import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSuperserveSandbox,
  SUPERSERVE_METADATA,
  type StoredSuperserveSandbox,
} from "../src/sandbox/superserve-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions, computerVerdict } from "../src/sandbox/sandbox.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { scopeId } from "../src/types.ts";
import { shq } from "../src/util/shell.ts";
import { installFakeSuperserve, type FakeSuperserve } from "./support/fake-superserve.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeSuperserve;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createSuperserveSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "superserve-ws-"))), {
    client: fake.client,
    namePrefix: "qmt",
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeSuperserve();
  sandbox = make();
});
after(() => fake?.cleanup());

test("profile advertises resident disk, process sessions, and the template's toolchain", () => {
  assert.equal(sandbox.profile.backend, "superserve");
  assert.equal(sandbox.profile.writablePersistence, "resident_disk");
  assert.equal(supportsProcessSessions(sandbox), true);
  for (const tool of ["node", "gh", "aws", "claude", "codex"])
    assert.ok(sandbox.profile.spec?.tools?.includes(tool), tool);
  assert.ok(!sandbox.profile.spec?.notInstalled?.includes("gh"));
});

test("output is capped while the command runs, and the exit code survives", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "head -c 3000000 /dev/zero | tr '\\0' a; echo err-side >&2; exit 7");
  assert.equal(r.code, 7);
  assert.equal(r.stdout.length, 2 * 1024 * 1024);
  assert.match(r.stderr, /err-side/);
  assert.match(r.stderr, /truncated/);
  const small = await sandbox.run(h, "printf ok; printf bad >&2; exit 0");
  assert.equal(small.stdout, "ok");
  assert.equal(small.stderr, "bad");
  assert.doesNotMatch(small.stderr, /truncated/);
});

test("commands are run under a timeout that force-kills a process ignoring SIGTERM", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  assert.ok(fake.execScripts().some((s) => /\btimeout -k \d+ \d+ sh -c /.test(s)));
});

test("provision creates one sandbox per scope with scope metadata and lifecycle knobs", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.ok(
    fake.execScripts().some((script) => script.includes("cd " + shq("/root/workspace").replace(/'/g, "'\\''"))),
    "workspace path quoted",
  );
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);

  const record = fake.current(scopeName());
  assert.ok(record);
  assert.equal(record.metadata[SUPERSERVE_METADATA.scope], scopeName());
  assert.equal(record.metadata[SUPERSERVE_METADATA.prefix], "qmt");
  assert.equal(record.metadata[SUPERSERVE_METADATA.kind], "scope");
  assert.equal(record.timeoutSeconds, 15 * 60);
  assert.equal(record.autoDeleteSeconds, 30 * 24 * 3600);
});

test("home is discovered from the guest, not assumed", async () => {
  const h = await sandbox.provision(layers);
  assert.equal(h.homeDir, "/root");
  assert.equal(h.rootDir, "/root/workspace");
});

test("egress allow/deny lists are applied at create time", async () => {
  sandbox = make({ egressAllow: ["api.anthropic.com", "*.github.com"], egressDeny: ["0.0.0.0/0"] });
  await sandbox.provision(layers);
  assert.deepEqual(fake.current(scopeName())?.network, {
    allowOut: ["api.anthropic.com", "*.github.com"],
    denyOut: ["0.0.0.0/0"],
  });
});

test("a paused sandbox is resumed as-is when the egress policy is unchanged", async () => {
  sandbox = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.anthropic.com"] });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  const again = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.anthropic.com"] });
  await again.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(fake.current(scopeName())?.status, "active");
});

test("a paused sandbox under a different egress policy is destroyed and replaced, never resumed", async () => {
  const errors: string[] = [];
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "old.txt", "stale\n");
  await sandbox.teardown(h);
  fake.pause(scopeName());
  const oldId = fake.current(scopeName())!.id;

  const tightened = make({
    egressDeny: ["0.0.0.0/0"],
    egressAllow: ["api.anthropic.com"],
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  const replaced = await tightened.provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: ["api.anthropic.com"], denyOut: ["0.0.0.0/0"] });
  assert.equal(fake.calls().indexOf(`connect:${oldId}`, fake.calls().indexOf(`pause:${oldId}`)), -1, "never resumed");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.deepEqual(errors, ["sandbox_egress:policy_changed"]);
  assert.equal(await tightened.readFile(replaced, "old.txt"), null);
});

test("an active sandbox gets a changed egress policy applied before its first command", async () => {
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { keepWarm: true });
  const id = fake.current(scopeName())!.id;

  const tightened = make({ egressDeny: ["0.0.0.0/0"], egressAllow: ["api.anthropic.com"] });
  await tightened.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: ["api.anthropic.com"], denyOut: ["0.0.0.0/0"] });
  const calls = fake.calls();
  const connectAt = calls.lastIndexOf(`connect:${id}`);
  const policyAt = calls.indexOf(`update:${id}`, connectAt);
  const firstRunAt = calls.indexOf(`run:${id}`, connectAt);
  assert.ok(policyAt > connectAt && policyAt < firstRunAt, "policy applied between adoption and the first command");
  const meta = fake.current(scopeName())!.metadata;
  assert.equal(meta[SUPERSERVE_METADATA.scope], scopeName());
  assert.equal(meta[SUPERSERVE_METADATA.kind], "scope");
  assert.ok(meta[SUPERSERVE_METADATA.egress]);

  const relaxed = make({ idlePauseSec: 120, retentionSec: 3600 });
  const relaxedHandle = await relaxed.provision(layers);
  assert.deepEqual(fake.current(scopeName())?.network, { allowOut: [], denyOut: [] });
  assert.equal(fake.current(scopeName())?.autoDeleteSeconds, 3600);
  await relaxed.teardown(relaxedHandle);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 120, "a shorter idle pause lands at the next plain teardown");
});

test("computerStatus observing a deleted sandbox clears cached state so the next provision replaces it", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  await sandbox.provision(layers);
  fake.expire(scopeName());
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, false);
  assert.equal(await store.get(scope), null);
  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("template and prefix flow through to creation", async () => {
  sandbox = make({ template: "qm-agent-1.2.3" });
  await sandbox.provision(layers);
  assert.equal(fake.current(scopeName())?.template, "qm-agent-1.2.3");
});

test("an already-aborted signal never executes a command", async () => {
  const handle = await sandbox.provision(layers);
  const before = fake.execScripts().length;
  await assert.rejects(sandbox.run(handle, "echo must-not-run", { signal: AbortSignal.abort() }), /aborted/i);
  assert.equal(fake.execScripts().length, before);
});

test("streams and exit codes are exact", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
});

test("file roundtrip incl. large binary and missing file", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  const seen = await sandbox.run(h, "wc -c < big.bin");
  assert.equal(seen.stdout.trim(), String(big.length));
});

test("importFiles, listDir and removeDir work through exec", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.importFiles!(h, [
    { path: "dir/one.txt", data: Buffer.from("1") },
    { path: "dir/two.txt", data: Buffer.from("2") },
  ]);
  const listed = await sandbox.listDir(h, "dir");
  assert.deepEqual(listed.sort(), ["dir/one.txt", "dir/two.txt"]);
  await sandbox.removeDir(h, "dir");
  assert.equal(await sandbox.readFile(h, "dir/one.txt"), null);
});

test("provisioning the same scope twice reuses the sandbox", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  assert.equal(a.id, b.id);
  assert.equal(b.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
});

test("teardown leaves the sandbox to the provider's idle pause; a paused sandbox resumes with its disk intact", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "keep.txt", "still here\n");
  await sandbox.teardown(h);
  assert.equal(fake.current(scopeName())?.status, "active");
  assert.ok(!fake.calls().some((c) => c.startsWith("pause:")));

  fake.pause(scopeName());
  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await sandbox.readFile(again, "keep.txt"), "still here\n");
  assert.equal(fake.current(scopeName())?.status, "active");
});

test("a sandbox built from an older template is replaced on adoption", async () => {
  const errors: string[] = [];
  sandbox = make({ template: "qm-agent-1.0.0" });
  const h = await sandbox.provision(layers);
  const oldId = fake.current(scopeName())!.id;
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.0.0");
  await sandbox.teardown(h);

  const upgraded = make({
    template: "qm-agent-1.1.0",
    onError: (e: { category: string; code: string }) => errors.push(`${e.category}:${e.code}`),
  });
  const replaced = await upgraded.provision(layers);
  assert.equal(replaced.coldStart, true);
  assert.notEqual(fake.current(scopeName())!.id, oldId);
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.1.0");
  assert.ok(fake.calls().includes(`kill:${oldId}`));
  assert.deepEqual(errors, ["sandbox_template:template_changed"]);

  const same = make({ template: "qm-agent-1.1.0" });
  const again = await same.provision(layers);
  assert.equal(again.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2);
});

test("an older core never reverts a sandbox a newer core already reconfigured", async () => {
  const older = make({ template: "qm-agent-1.0.0", configEpochMs: 1_000 });
  const first = await older.provision(layers);
  await older.teardown(first);

  const newer = make({ template: "qm-agent-1.1.0", configEpochMs: 2_000, egressDeny: ["0.0.0.0/0"] });
  await newer.provision(layers);
  assert.equal(fake.createdCount(scopeName()), 2);
  const upgradedId = fake.current(scopeName())!.id;

  const olderAgain = make({ template: "qm-agent-1.0.0", configEpochMs: 1_000 });
  const h = await olderAgain.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 2, "no third sandbox");
  assert.equal(fake.current(scopeName())!.id, upgradedId);
  assert.equal(fake.current(scopeName())?.metadata[SUPERSERVE_METADATA.template], "qm-agent-1.1.0");
  assert.deepEqual(fake.current(scopeName())?.network, { denyOut: ["0.0.0.0/0"] });
  assert.equal((await olderAgain.run(h, "echo ok")).stdout.trim(), "ok");
});

test("a gone sandbox never forgets a replacement another instance already recorded", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  const oldId = fake.current(scopeName())!.id;
  fake.expire(scopeName());
  const other = make({ store });
  const replacement = await other.provision(layers);
  assert.equal(replacement.coldStart, true);
  const newId = (await store.get(scope))!.sandboxId;
  assert.notEqual(newId, oldId);

  await assert.rejects(sandbox.run(h, "echo x"), /is gone/);
  assert.equal((await store.get(scope))?.sandboxId, newId, "the replacement's record survives");
  const status = await sandbox.computerStatus!(scope);
  assert.equal(status.provisioned, true);
});

test("reconnecting keeps a longer keep-warm timeout until a plain teardown restores it", async () => {
  sandbox = make({ idlePauseSec: 600, keepWarmSec: 5400 });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 5400);

  const other = make({ idlePauseSec: 600, keepWarmSec: 5400 });
  await other.computerStatus!(scope);
  const probed = await other.provision(layers);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 5400, "another instance's probe keeps the warm window");
  await other.teardown(probed);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 600);
});

test("keepWarm teardown extends the provider idle pause; a plain teardown restores it", async () => {
  sandbox = make({ idlePauseSec: 600, keepWarmSec: 5400 });
  const h = await sandbox.provision(layers);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 600);
  await sandbox.teardown(h, { keepWarm: true });
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 5400);
  assert.equal(fake.current(scopeName())?.status, "active");
  await sandbox.teardown(h);
  assert.equal(fake.current(scopeName())?.timeoutSeconds, 600);
});

test("a concurrent handle keeps working after another handle's teardown", async () => {
  const a = await sandbox.provision(layers);
  const b = await sandbox.provision(layers);
  await sandbox.teardown(a);
  const r = await sandbox.run(b, "echo still-running");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /still-running/);
});

test("a fresh core with an empty store rediscovers the sandbox by scope metadata", async () => {
  const first = await sandbox.provision(layers);
  await sandbox.writeFile(first, "state.txt", "from before\n");
  await sandbox.teardown(first);

  const restarted = make();
  const h = await restarted.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await restarted.readFile(h, "state.txt"), "from before\n");
});

test("a durable store lets a restarted core reconnect without listing", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const first = await sandbox.provision(layers);
  await sandbox.teardown(first);
  const stored = await store.get(scope);
  assert.ok(stored);

  const restarted = make({ store });
  const before = fake.calls().filter((c) => c.startsWith("create:")).length;
  const h = await restarted.provision(layers);
  assert.equal(h.coldStart, false);
  assert.equal(fake.calls().filter((c) => c.startsWith("create:")).length, before);
  assert.ok(fake.calls().includes(`connect:${stored.sandboxId}`));
});

test("a sandbox that disappeared is replaced on the next provision", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h);
  fake.expire(scopeName());

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.notEqual((await store.get(scope))?.sandboxId, undefined);
});

test("a sandbox lost mid-session fails the command and is replaced by the next provision", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  fake.expire(scopeName());
  await assert.rejects(sandbox.run(h, "echo back"), /is gone/);
  await assert.rejects(sandbox.run(h, "echo again"), /provision it again/);
  await assert.rejects(sandbox.readFile(h, "x.txt"), /provision it again/);
  assert.equal(fake.createdCount(scopeName()), 1);
  assert.equal(await store.get(scope), null);

  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.equal(fake.createdCount(scopeName()), 2);
  assert.equal((await sandbox.run(again, "echo back")).stdout.trim(), "back");
});

test("destroyScope surfaces a failed listing instead of forgetting the scope", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  await sandbox.provision(layers);
  fake.failNextList(new Error("superserve unavailable"));
  await assert.rejects(sandbox.destroyScope!(scope), /unavailable/);
  assert.ok(await store.get(scope), "record survives so retirement can be retried");
  assert.ok(fake.current(scopeName()), "sandbox untouched");
  await sandbox.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
});

test("destroy teardown and destroyScope kill the sandbox and forget the scope", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  const h = await sandbox.provision(layers);
  await sandbox.teardown(h, { destroy: true });
  assert.equal(fake.current(scopeName()), null);
  assert.equal(await store.get(scope), null);

  const h2 = await sandbox.provision(layers);
  assert.equal(h2.coldStart, true);
  await sandbox.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
  assert.equal(await store.get(scope), null);
});

test("destroyScope also removes sandboxes only findable by metadata", async () => {
  await sandbox.provision(layers);
  const orphanOwner = make();
  await orphanOwner.destroyScope!(scope);
  assert.equal(fake.current(scopeName()), null);
});

test("computerStatus reports paused, running, and gone", async () => {
  const store: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  sandbox = make({ store });
  assert.equal(computerVerdict(await sandbox.computerStatus!(scope)), "down");

  const h = await sandbox.provision(layers);
  const running = await sandbox.computerStatus!(scope);
  assert.equal(running.guestResponsive, true);
  assert.equal(running.lifecycleState, "running");
  assert.equal(computerVerdict(running), "ok");

  await sandbox.teardown(h);
  fake.pause(scopeName());
  const paused = await sandbox.computerStatus!(scope);
  assert.equal(paused.lifecycleState, "paused");
  assert.equal(paused.recovery?.strategy, "provider_pause");
  assert.equal(computerVerdict(paused), "ok");

  fake.expire(scopeName());
  const gone = await sandbox.computerStatus!(scope);
  assert.equal(gone.provisioned, false);
  assert.equal(computerVerdict(gone), "down");
});

test("scratch sandboxes are separate, shared while active, and killed on last teardown", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "k1" } });
  const b = await sandbox.provision(layers, { scratch: { key: "k1" } });
  assert.equal(a.id, b.id);
  assert.equal(a.scratch, true);
  assert.equal(b.coldStart, false);
  const scratchName = a.id;
  assert.equal(fake.current(scratchName)?.metadata[SUPERSERVE_METADATA.kind], "scratch");
  assert.equal(fake.current(scratchName)?.autoDeleteSeconds, 24 * 3600);

  await sandbox.teardown(a);
  assert.ok(fake.current(scratchName), "still alive while another user holds it");
  await sandbox.teardown(b);
  assert.equal(fake.current(scratchName), null);
  assert.equal(fake.current(scopeName()), null, "scratch never touches the scope sandbox");
});

test("a scratch sandbox lost while handles are active is recreated for the next scratch provision", async () => {
  const a = await sandbox.provision(layers, { scratch: { key: "job" } });
  const scratchName = a.id;
  fake.expire(scratchName);
  await assert.rejects(sandbox.run(a, "echo x"), /is gone/);
  const b = await sandbox.provision(layers, { scratch: { key: "job" } });
  assert.equal(b.coldStart, true);
  assert.equal(fake.createdCount(scratchName), 2);
  assert.equal((await sandbox.run(b, "echo back")).stdout.trim(), "back");
});

test("process sessions run in the background and can be read back", async () => {
  const h = await sandbox.provision(layers);
  assert.ok(supportsProcessSessions(sandbox));
  const { processId } = await sandbox.startProcess(h, "echo started; sleep 0.2; echo finished");
  let out = "";
  for (let i = 0; i < 40; i++) {
    const r = await sandbox.readProcess(h, processId, { sinceCursor: 0 });
    out = r.chunks;
    if (r.status.state === "exited") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(out, /started/);
  assert.match(out, /finished/);
  const listed = await sandbox.listProcesses(h);
  assert.ok(listed.some((p) => p.processId === processId));
});

test("no access token or key ever appears in exec scripts", async () => {
  sandbox = make();
  const h = await sandbox.provision(layers);
  await sandbox.run(h, "true");
  for (const script of fake.execScripts()) {
    assert.doesNotMatch(script, /ss_live_|X-Access-Token|access_token/);
  }
});

test("a sandbox is not cached when its durable record cannot be written", async () => {
  const inner: DurableMap<StoredSuperserveSandbox> = createMemoryMap();
  let failPuts = 1;
  const store: DurableMap<StoredSuperserveSandbox> = {
    ...inner,
    put: async (key, value) => {
      if (failPuts-- > 0) throw new Error("persistence unavailable");
      return inner.put(key, value);
    },
  };
  sandbox = make({ store });
  await assert.rejects(sandbox.provision(layers), /persistence unavailable/);
  const h = await sandbox.provision(layers);
  assert.ok(await inner.get(scope), "record written on the retry");
  assert.equal((await inner.get(scope))?.sandboxId, fake.current(scopeName())?.id);
  assert.equal((await sandbox.run(h, "echo ok")).stdout.trim(), "ok");
});
