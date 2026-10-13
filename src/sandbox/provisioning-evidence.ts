import { createKeyedQueue } from "../util/async.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { SandboxReuseSource, VerifiedSandboxIdentity } from "../runs/sandbox-provisions.ts";
import { provisioningUnavailable } from "../runs/sandbox-provisions.ts";

export interface SandboxProvisionScope {
  scopeId: string;
  backingScopeId: string;
  template?: string;
}

export interface SandboxProvisioning {
  withProvision<T>(action: () => Promise<T>): Promise<T>;
  assertReady(): Promise<void>;
  beginCreate(
    scope: SandboxProvisionScope,
  ): Promise<{ created(providerSandboxId: string): Promise<void>; uncertain(): Promise<void> }>;
  reused(scope: SandboxProvisionScope, providerSandboxId: string, source: SandboxReuseSource): Promise<void>;
}

const queues = new WeakMap<RunStore, ReturnType<typeof createKeyedQueue>>();

export function createRunSandboxProvisioning(opts: {
  runs: RunStore;
  identity: VerifiedSandboxIdentity;
  runId?: string;
  runLeaseToken?: string;
  attempt?: number;
  onChange(runId: string): void;
}): SandboxProvisioning {
  const { runs, identity, runId, runLeaseToken, attempt } = opts;
  const store = runs.sandboxProvisions;
  let queue = queues.get(runs);
  if (!queue) {
    queue = createKeyedQueue();
    queues.set(runs, queue);
  }
  const current = async (): Promise<void> => {
    if (!runId || !runLeaseToken || !store || !attempt) throw provisioningUnavailable();
    const run = await runs.get(runId);
    if (
      !run ||
      run.status !== "running" ||
      run.leaseToken !== runLeaseToken ||
      run.attempts !== attempt ||
      (run.leaseExpiresAt ?? 0) <= Date.now()
    )
      throw provisioningUnavailable();
  };
  const changed = (): void => {
    try {
      opts.onChange(runId!);
    } catch (error) {
      void error;
    }
  };
  return {
    withProvision(action) {
      if (!runId) return Promise.reject(provisioningUnavailable());
      return queue!(runId, action);
    },
    async assertReady() {
      await current();
      if ((await store!.list(runId!)).some((record) => record.outcome === "pending" || record.outcome === "uncertain"))
        throw provisioningUnavailable();
    },
    async beginCreate(scope) {
      await current();
      const receipt = await store!.begin(runId!, runLeaseToken!, { ...scope, ...identity });
      changed();
      return {
        async created(providerSandboxId) {
          await store!.confirm(runId!, runLeaseToken!, receipt.receiptId, "created", providerSandboxId);
          changed();
          await current();
        },
        async uncertain() {
          await store!.confirm(runId!, runLeaseToken!, receipt.receiptId, "uncertain");
          changed();
        },
      };
    },
    async reused(scope, providerSandboxId, source) {
      await current();
      await store!.reuse(runId!, runLeaseToken!, { ...scope, ...identity }, providerSandboxId, source);
      changed();
      await current();
    },
  };
}
