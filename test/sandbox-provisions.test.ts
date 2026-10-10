import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { MAX_RUN_SANDBOX_PROVISIONS } from "../src/runs/sandbox-provisions.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import { createRunSandboxProvisioning } from "../src/sandbox/provisioning-evidence.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { createPostgresRunSignalStore } from "../src/runs/postgres-run-signal-store.ts";
import { loadConfig } from "../src/config.ts";

const identity = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  machinePrincipalId: "machine-fixture",
  manifestId: "33333333-3333-4333-8333-333333333333",
  releaseImage: `123456789012.dkr.ecr.us-west-2.amazonaws.com/qm/tenant@sha256:${"a".repeat(64)}`,
};
const binding = {
  ...identity,
  scopeId: "personal:operator@example.com",
  backingScopeId: "personal:resource-one",
  template: "qm-agent-fixture",
};
const request = {
  actor: { id: "operator@example.com", type: "internal" as const },
  conversation: { kind: "dm" as const, threadRef: "fixture", audience: [] },
  text: "fixture",
  origin: { kind: "direct" as const },
};
async function claimed(runs: RunStore) {
  const { run } = await runs.enqueue({ sessionId: randomUUID(), request });
  return (await runs.claimById(run.id, "fixture-worker", 60_000))!;
}

for (const backend of ["memory", "postgres"] as const) {
  const make = () =>
    backend === "memory"
      ? { ...createMemoryRunStore(), close: async () => undefined }
      : createPostgresRunStore(process.env.DATABASE_URL!);
  test(
    `${backend}: creation is fenced, durable, and never replaced by reuse`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async (t) => {
      const runtime = make();
      t.after(() => runtime.close());
      const run = await claimed(runtime.runs);
      const token = run.leaseToken!;
      const store = runtime.runs.sandboxProvisions!;
      const outcomes = await Promise.allSettled([
        store.begin(run.id, token, binding),
        store.begin(run.id, token, binding),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      const receipt = (await store.list(run.id))[0]!;
      assert.equal(receipt.outcome, "pending");
      await assert.rejects(store.confirm(run.id, "wrong-lease", receipt.receiptId, "created", "usw-original-id"));
      await store.confirm(run.id, token, receipt.receiptId, "created", "usw-original-id");
      await store.confirm(run.id, token, receipt.receiptId, "created", "usw-original-id");
      await assert.rejects(store.confirm(run.id, token, receipt.receiptId, "created", "different-id"));
      await store.reuse(run.id, token, binding, "usw-original-id", "stored");
      const records = await store.list(run.id);
      assert.deepEqual(
        records.map((r) => r.outcome),
        ["created", "reused"],
      );
      assert.equal(records[0]!.providerSandboxId, "usw-original-id");
      assert.equal(records[0]!.scopeId, binding.scopeId);
      assert.equal(records[0]!.backingScopeId, binding.backingScopeId);
      assert.ok(!JSON.stringify(records).includes(token));
      if (backend === "postgres") {
        await runtime.close();
        const reopened = make();
        t.after(() => reopened.close());
        assert.deepEqual(await reopened.runs.sandboxProvisions!.list(run.id), records);
      }
    },
  );
  test(
    `${backend}: queued withdrawal and steering retain provisioning evidence for late confirmation`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async (t) => {
      const runtime = make();
      t.after(() => runtime.close());
      const signals =
        backend === "postgres" ? createPostgresRunSignalStore(process.env.DATABASE_URL!) : createMemoryRunSignalStore();
      t.after(() => signals.close?.());
      const run = await claimed(runtime.runs);
      const token = run.leaseToken!;
      const store = runtime.runs.sandboxProvisions!;
      const receipt = await store.begin(run.id, token, binding);
      await runtime.runs.releaseLease(run.id, token);
      const target = await runtime.runs.enqueue({ sessionId: randomUUID(), request });
      assert.equal(await runtime.runs.withdraw(run.id), false);
      assert.equal(
        await runtime.runs.steerQueued(
          run.id,
          target.run.id,
          {
            kind: "steer",
            request: {
              surface: "web",
              actor: { externalId: request.actor.id },
              conversation: request.conversation,
              text: request.text,
            },
            dedupeKey: randomUUID(),
          },
          signals,
        ),
        false,
      );
      await store.confirm(run.id, token, receipt.receiptId, "created", "usw-late-created");
      assert.ok(await runtime.runs.get(run.id));
      assert.equal((await store.list(run.id))[0]!.providerSandboxId, "usw-late-created");
      const withdrawals = await Promise.all([
        runtime.runs.withdraw(target.run.id),
        runtime.runs.withdraw(target.run.id),
      ]);
      assert.equal(withdrawals.filter(Boolean).length, 1);
    },
  );
  test(
    `${backend}: unresolved provisioning blocks the next lease and has a bounded record count`,
    { skip: backend === "postgres" && !process.env.DATABASE_URL },
    async (t) => {
      const runtime = make();
      t.after(() => runtime.close());
      const run = await claimed(runtime.runs);
      const token = run.leaseToken!;
      const store = runtime.runs.sandboxProvisions!;
      const receipt = await store.begin(run.id, token, binding);
      await runtime.runs.releaseLease(run.id, token);
      const next = (await runtime.runs.claimById(run.id, "next-worker", 60_000))!;
      await assert.rejects(store.begin(run.id, next.leaseToken!, binding));
      await store.confirm(run.id, token, receipt.receiptId, "uncertain");
      await assert.rejects(store.reuse(run.id, next.leaseToken!, binding, "untrusted-inferred-id", "adopted"));
      const bounded = await claimed(runtime.runs);
      const boundedToken = bounded.leaseToken!;
      for (let i = 0; i < MAX_RUN_SANDBOX_PROVISIONS; i++)
        await store.reuse(bounded.id, boundedToken, binding, `sandbox-${i}`, "cached");
      await assert.rejects(store.begin(bounded.id, boundedToken, binding));
      assert.equal((await store.list(bounded.id)).length, MAX_RUN_SANDBOX_PROVISIONS);
    },
  );
}

test("a late successful create is retained under its original attempt but cannot continue execution", async () => {
  const { runs } = createMemoryRunStore();
  const run = await claimed(runs);
  const token = run.leaseToken!;
  const changes: string[] = [];
  const evidence = createRunSandboxProvisioning({
    runs,
    identity,
    runId: run.id,
    runLeaseToken: token,
    attempt: 1,
    onChange: (id) => changes.push(id),
  });
  const operation = await evidence.beginCreate(binding);
  await runs.releaseLease(run.id, token);
  await runs.claimById(run.id, "next-worker", 60_000);
  await assert.rejects(operation.created("usw-provider-id"));
  const records = await runs.sandboxProvisions!.list(run.id);
  assert.equal(records[0]!.outcome, "created");
  assert.equal(records[0]!.attempt, 1);
  assert.equal(records[0]!.providerSandboxId, "usw-provider-id");
  assert.equal(changes.length, 2);
  await assert.rejects(evidence.assertReady());
});

test("explicit machine mode preserves ordinary keys and requires complete durable provenance", () => {
  const machine = {
    SANDBOX_BACKEND: "superserve",
    SUPERSERVE_MACHINE_CREDENTIAL: "synthetic-machine-root",
    SUPERSERVE_BASE_URL: "https://api.example.test",
    SUPERSERVE_SANDBOX_HOST: "sandbox.example.test",
    SUPERSERVE_TEMPLATE: "qm-agent-fixture",
  };
  assert.equal(loadConfig(machine).superserveSandbox.machineCredential, machine.SUPERSERVE_MACHINE_CREDENTIAL);
  assert.equal(
    loadConfig({ ...machine, SUPERSERVE_MACHINE_CREDENTIAL: undefined, SUPERSERVE_API_KEY: "ordinary-key" })
      .superserveSandbox.apiKey,
    "ordinary-key",
  );
  assert.throws(() => loadConfig({ ...machine, SUPERSERVE_API_KEY: "ordinary-key" }), /cannot be combined/);
  assert.throws(() => loadConfig({ ...machine, SUPERSERVE_BASE_URL: undefined }), /explicit HTTPS/);
  assert.throws(
    () => loadConfig({ ...machine, SUPERSERVE_SANDBOX_HOST: undefined }),
    /require SUPERSERVE_SANDBOX_HOST/,
  );
  assert.throws(() => loadConfig({ ...machine, SUPERSERVE_SANDBOX_HOST: " " }), /require SUPERSERVE_SANDBOX_HOST/);
  assert.equal(
    loadConfig({ ...machine, SUPERSERVE_BASE_URL: "https://api-usw.superserve.ai", SUPERSERVE_SANDBOX_HOST: undefined })
      .superserveSandbox.sandboxHost,
    undefined,
  );
  assert.throws(() => loadConfig({ ...machine, QM_VERIFIED_TENANT_ID: identity.tenantId }), /Complete verified/);
  const provenance = {
    QM_VERIFIED_TENANT_ID: identity.tenantId,
    QM_VERIFIED_TEAM_ID: identity.teamId,
    QM_VERIFIED_MACHINE_PRINCIPAL_ID: identity.machinePrincipalId,
    QM_VERIFIED_MANIFEST_ID: identity.manifestId,
    QM_VERIFIED_RELEASE_IMAGE: identity.releaseImage,
  };
  assert.throws(() => loadConfig({ ...machine, ...provenance }), /durable Postgres/);
  const config = loadConfig({
    ...machine,
    ...provenance,
    RUN_STORE: "postgres",
    DATABASE_URL: "postgres://fixture@localhost/qm",
  });
  assert.deepEqual(config.verifiedSandboxIdentity, identity);
});
