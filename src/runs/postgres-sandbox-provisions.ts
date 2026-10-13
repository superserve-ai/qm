import type { createPgPool } from "../persistence/pg-pool.ts";
import {
  MAX_RUN_SANDBOX_PROVISIONS,
  newSandboxProvision,
  provisioningUnavailable,
  validateProvisionBinding,
  validateProvisionConfirmation,
  validateProvisionText,
} from "./sandbox-provisions.ts";
import type {
  RunSandboxProvision,
  RunSandboxProvisionStore,
  SandboxProvisionBinding,
  SandboxReuseSource,
} from "./sandbox-provisions.ts";

export const sandboxProvisionMigration = {
  id: "runs/store/0005-sandbox-provisions",
  statements: [
    `CREATE TABLE IF NOT EXISTS run_sandbox_provisions (
      receipt_id TEXT PRIMARY KEY,
      seq BIGSERIAL NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
      lease_token TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('pending','created','reused','uncertain')),
      receipt JSONB NOT NULL,
      created_at BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_run_sandbox_provisions_run ON run_sandbox_provisions(run_id, seq)`,
  ],
};

export function createPostgresSandboxProvisions(pg: ReturnType<typeof createPgPool>): RunSandboxProvisionStore {
  const insert = async (
    runId: string,
    leaseToken: string,
    binding: SandboxProvisionBinding,
    reused?: { id: string; source: SandboxReuseSource },
  ): Promise<RunSandboxProvision> => {
    validateProvisionBinding(binding);
    if (reused) {
      validateProvisionText(reused.id);
      if (!["cached", "stored", "adopted"].includes(reused.source)) throw provisioningUnavailable();
    }
    const client = await (await pg.pool()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const { rows } = await client.query(
        "SELECT id, attempts, status, lease_token, lease_expires_at FROM runs WHERE id=$1 FOR UPDATE",
        [runId],
      );
      const now = Number(
        (await client.query("SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now")).rows[0].now,
      );
      const run = rows[0];
      if (
        !run ||
        run.status !== "running" ||
        run.lease_token !== leaseToken ||
        Number(run.lease_expires_at ?? 0) <= now
      )
        throw provisioningUnavailable();
      const existing = await client.query("SELECT outcome FROM run_sandbox_provisions WHERE run_id=$1", [runId]);
      if (
        existing.rows.length >= MAX_RUN_SANDBOX_PROVISIONS ||
        existing.rows.some((row) => row.outcome === "pending" || row.outcome === "uncertain")
      )
        throw provisioningUnavailable();
      const receipt = newSandboxProvision({ id: runId, attempts: Number(run.attempts) }, binding, now);
      if (reused)
        Object.assign(receipt, {
          outcome: "reused",
          providerSandboxId: reused.id,
          reusedProvenance: reused.source,
          confirmedAt: now,
        });
      await client.query(
        "INSERT INTO run_sandbox_provisions(receipt_id,run_id,lease_token,outcome,receipt,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
        [receipt.receiptId, runId, leaseToken, receipt.outcome, JSON.stringify(receipt), now],
      );
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  return {
    begin: (runId, leaseToken, binding) => insert(runId, leaseToken, binding),
    reuse: (runId, leaseToken, binding, id, source) => insert(runId, leaseToken, binding, { id, source }),
    async confirm(runId, leaseToken, receiptId, outcome, providerSandboxId) {
      validateProvisionConfirmation(outcome, providerSandboxId);
      const { rowCount } = await pg.query(
        `UPDATE run_sandbox_provisions SET outcome=$4,
        receipt=receipt || jsonb_build_object('outcome',$4::text,'confirmedAt',floor(extract(epoch FROM clock_timestamp())*1000)::bigint)
          || CASE WHEN $5::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('providerSandboxId',$5::text) END
        WHERE run_id=$1 AND lease_token=$2 AND receipt_id=$3 AND outcome='pending'`,
        [runId, leaseToken, receiptId, outcome, providerSandboxId ?? null],
      );
      if (rowCount === 1) return;
      const { rows } = await pg.query(
        "SELECT receipt FROM run_sandbox_provisions WHERE run_id=$1 AND lease_token=$2 AND receipt_id=$3",
        [runId, leaseToken, receiptId],
      );
      const prior = rows[0]?.receipt as RunSandboxProvision | undefined;
      if (prior?.outcome !== outcome || prior.providerSandboxId !== providerSandboxId) throw provisioningUnavailable();
    },
    async list(runId) {
      const { rows } = await pg.query(
        "SELECT receipt FROM run_sandbox_provisions WHERE run_id=$1 ORDER BY seq LIMIT $2",
        [runId, MAX_RUN_SANDBOX_PROVISIONS],
      );
      return rows.map((row) => row.receipt as RunSandboxProvision);
    },
  };
}
