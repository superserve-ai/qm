import { randomUUID } from "node:crypto";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import type { Run } from "./run-store.ts";

export interface VerifiedSandboxIdentity {
  tenantId: string;
  teamId: string;
  machinePrincipalId: string;
  manifestId: string;
  releaseImage: string;
}

export interface SandboxProvisionBinding extends VerifiedSandboxIdentity {
  scopeId: string;
  backingScopeId: string;
  template?: string;
}

export type SandboxReuseSource = "cached" | "stored" | "adopted";

export interface RunSandboxProvision extends SandboxProvisionBinding {
  version: 1;
  receiptId: string;
  runId: string;
  attempt: number;
  provider: "superserve";
  outcome: "pending" | "created" | "reused" | "uncertain";
  providerSandboxId?: string;
  reusedProvenance?: SandboxReuseSource;
  createdAt: number;
  confirmedAt?: number;
}

export interface RunSandboxProvisionStore {
  begin(runId: string, leaseToken: string, binding: SandboxProvisionBinding): Promise<RunSandboxProvision>;
  reuse(
    runId: string,
    leaseToken: string,
    binding: SandboxProvisionBinding,
    providerSandboxId: string,
    source: SandboxReuseSource,
  ): Promise<RunSandboxProvision>;
  confirm(
    runId: string,
    leaseToken: string,
    receiptId: string,
    outcome: "created" | "uncertain",
    providerSandboxId?: string,
  ): Promise<void>;
  list(runId: string): Promise<RunSandboxProvision[]>;
}

export const MAX_RUN_SANDBOX_PROVISIONS = 16;

export function provisioningUnavailable(): NonRetryableTurnError {
  return new NonRetryableTurnError(
    "Sandbox provisioning evidence is unavailable; no further sandbox may be created by this run.",
  );
}

export function validateProvisionText(value: string): void {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x20\x7f]/.test(value))
    throw provisioningUnavailable();
}

export function validateProvisionBinding(binding: SandboxProvisionBinding): void {
  for (const value of Object.values(binding)) validateProvisionText(value);
  for (const key of [
    "tenantId",
    "teamId",
    "machinePrincipalId",
    "manifestId",
    "releaseImage",
    "scopeId",
    "backingScopeId",
  ] as const)
    validateProvisionText(binding[key]);
}

export function validateProvisionConfirmation(outcome: "created" | "uncertain", providerSandboxId?: string): void {
  if (outcome === "created") validateProvisionText(providerSandboxId!);
  else if (outcome !== "uncertain" || providerSandboxId !== undefined) throw provisioningUnavailable();
}

export function newSandboxProvision(
  run: Pick<Run, "id" | "attempts">,
  binding: SandboxProvisionBinding,
  now: number,
): RunSandboxProvision {
  validateProvisionBinding(binding);
  return {
    tenantId: binding.tenantId,
    teamId: binding.teamId,
    machinePrincipalId: binding.machinePrincipalId,
    manifestId: binding.manifestId,
    releaseImage: binding.releaseImage,
    scopeId: binding.scopeId,
    backingScopeId: binding.backingScopeId,
    ...(binding.template ? { template: binding.template } : {}),
    version: 1,
    receiptId: randomUUID(),
    runId: run.id,
    attempt: run.attempts,
    provider: "superserve",
    outcome: "pending",
    createdAt: now,
  };
}

export function createMemorySandboxProvisions(getRun: (runId: string) => Run | undefined): RunSandboxProvisionStore {
  const records = new Map<string, { leaseToken: string; receipt: RunSandboxProvision }[]>();
  const insert = (
    runId: string,
    leaseToken: string,
    binding: SandboxProvisionBinding,
    reused?: { id: string; source: SandboxReuseSource },
  ): RunSandboxProvision => {
    const run = getRun(runId);
    const now = Date.now();
    const entries = records.get(runId) ?? [];
    if (
      !run ||
      run.status !== "running" ||
      run.leaseToken !== leaseToken ||
      (run.leaseExpiresAt ?? 0) <= now ||
      entries.length >= MAX_RUN_SANDBOX_PROVISIONS ||
      entries.some(({ receipt }) => receipt.outcome === "pending" || receipt.outcome === "uncertain")
    )
      throw provisioningUnavailable();
    const receipt = newSandboxProvision(run, binding, now);
    if (reused) {
      validateProvisionText(reused.id);
      if (!["cached", "stored", "adopted"].includes(reused.source)) throw provisioningUnavailable();
      Object.assign(receipt, {
        outcome: "reused",
        providerSandboxId: reused.id,
        reusedProvenance: reused.source,
        confirmedAt: now,
      });
    }
    entries.push({ leaseToken, receipt });
    records.set(runId, entries);
    return structuredClone(receipt);
  };
  return {
    async begin(runId, leaseToken, binding) {
      return insert(runId, leaseToken, binding);
    },
    async reuse(runId, leaseToken, binding, id, source) {
      return insert(runId, leaseToken, binding, { id, source });
    },
    async confirm(runId, leaseToken, receiptId, outcome, providerSandboxId) {
      validateProvisionConfirmation(outcome, providerSandboxId);
      const stored = records
        .get(runId)
        ?.find((entry) => entry.receipt.receiptId === receiptId && entry.leaseToken === leaseToken);
      if (!stored) throw provisioningUnavailable();
      if (stored.receipt.outcome !== "pending") {
        if (stored.receipt.outcome === outcome && stored.receipt.providerSandboxId === providerSandboxId) return;
        throw provisioningUnavailable();
      }
      stored.receipt = {
        ...stored.receipt,
        outcome,
        ...(providerSandboxId ? { providerSandboxId } : {}),
        confirmedAt: Date.now(),
      };
    },
    async list(runId) {
      return structuredClone((records.get(runId) ?? []).map(({ receipt }) => receipt));
    },
  };
}
