# Native tenant sandbox receipts

The tenant helper supplies `QM_VERIFIED_TENANT_ID`, `QM_VERIFIED_TEAM_ID`,
`QM_VERIFIED_MACHINE_PRINCIPAL_ID`, `QM_VERIFIED_MANIFEST_ID`, and
`QM_VERIFIED_RELEASE_IMAGE` after authenticated bootstrap and activation checks.
All five fields require explicit `SUPERSERVE_MACHINE_CREDENTIAL` and the PostgreSQL
run store. `ORG_ID` and request bodies are not provenance authorities.

Machine authentication requires an explicit HTTPS `SUPERSERVE_BASE_URL` and excludes
`SUPERSERVE_API_KEY`. Known Superserve API origins select their corresponding sandbox
hosts. Custom origins additionally require `SUPERSERVE_SANDBOX_HOST`, a DNS suffix
validated by the SDK. Ordinary API-key deployments retain their existing behavior.
The local SDK tarball, source revision, and integrity are recorded in
`vendor/sdk-provenance.json` and `package-lock.json`; its unchanged version number
alone does not identify this backport.

Authenticated run reads and run SSE snapshots optionally include:

```json
{
  "sandboxProvisioning": {
    "version": 1,
    "receipts": [
      {
        "version": 1,
        "receiptId": "opaque-receipt-id",
        "runId": "exact-run-id",
        "attempt": 1,
        "provider": "superserve",
        "outcome": "created",
        "providerSandboxId": "full-original-provider-id",
        "scopeId": "personal:owner",
        "backingScopeId": "sandbox-resource-id",
        "tenantId": "verified-tenant-id",
        "teamId": "verified-team-id",
        "machinePrincipalId": "verified-principal-id",
        "manifestId": "verified-manifest-id",
        "releaseImage": "immutable-release-image",
        "createdAt": 0,
        "confirmedAt": 1
      }
    ]
  }
}
```

A pending receipt is committed before provider Create. Only the successful Create
response supplies a `created` ID, committed before sandbox preparation. Reconnection
adds a distinct `reused` receipt with `reusedProvenance` of `cached`, `stored`, or
`adopted`. A lost Create response becomes `uncertain`; a failed confirmation remains
`pending`. Either blocks subsequent provisioning for that run. Late confirmation
retains the original attempt while lease checks prevent the stale attempt from
continuing. Runs with receipts cannot be deleted by queued withdrawal or steering.

Consumers must read the exact run they submitted through its existing authenticated
visibility checks. Take the expected logical scope from the server-authenticated
session. A simple personal-session demo can require an unchanged default backing
scope equal to that session scope; environment or explicit-resource backings require
the corresponding authorized server mapping. Do not derive the expected scope from
display names, request-body claims, or the receipt being checked. For a demo that requires one new sandbox, accept exactly one
`created` receipt with matching verified release identity; reject missing, pending,
uncertain, reused-only, or multiple-created evidence. Never infer creation from
sandbox listings, names, timestamps, or display IDs. The field is absent for legacy
runs without receipts. No credential, lease token, or raw provider response is exposed.

Maintenance can reconnect an existing sandbox without a run receipt, but cannot
create or destructively replace it. With a verified identity this also refuses
Superserve creations that have no originating run: swarm workers and computers an
operator creates or migrates through the admin API. Those paths stay unavailable on
verified tenants until they can carry receipts of their own. A run's concurrent provisioning operations wait
in process; durable receipt and lease checks remain authoritative across workers.
