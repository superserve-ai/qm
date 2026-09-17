# Superserve agent sandboxes

The `superserve` sandbox backend runs each QM scope in a Superserve Firecracker
microVM. QM itself can run on Docker, Fly, or AWS; selecting this backend changes
where agent commands execute, not where core and its plugins are hosted.

## Configure

Build a `qm-agent-<release>` template with the
[template builder and verifier](../superserve/templates/README.md), then configure
core with:

```sh
SANDBOX_BACKEND=superserve
SUPERSERVE_API_KEY=your-superserve-api-key
SUPERSERVE_TEMPLATE=qm-agent-0.1.0
SUPERSERVE_NAME_PREFIX=my-qm
```

Store the API key as a core service secret. Production also requires `DATABASE_URL`:
QM uses Postgres for sandbox records, provisioning locks, and configuration ordering
across core instances. Use a different name prefix for each independent deployment
sharing a Superserve team, including development instances.

For CLI deployments, merge these fields into the deployment config and provide the
API key through the CLI's secret configuration:

```json
{
  "sandbox": { "backend": "superserve" },
  "env": {
    "core": {
      "SUPERSERVE_TEMPLATE": "qm-agent-0.1.0",
      "SUPERSERVE_NAME_PREFIX": "my-qm"
    }
  }
}
```

`env.core.SANDBOX_BACKEND` overrides `sandbox.backend`. Superserve can also be
selected for individual scope kinds through `SANDBOX_SCOPE_BACKENDS`; the same
template, key, and production database requirements apply.

For local development, export the key and template and run
`npm run dev-instance -- --sandbox superserve`.

## Settings

| Variable                       | Default                    | Purpose                                                                           |
| ------------------------------ | -------------------------- | --------------------------------------------------------------------------------- |
| `SUPERSERVE_API_KEY`           | Required                   | Superserve team API key, held by core rather than embedded in guest commands.     |
| `SUPERSERVE_TEMPLATE`          | Required                   | Ready template name carrying the agent toolchain.                                 |
| `SUPERSERVE_BASE_URL`          | SDK default                | Optional API endpoint override.                                                   |
| `SUPERSERVE_NAME_PREFIX`       | `qm`                       | Deployment namespace for scope discovery.                                         |
| `SUPERSERVE_HOME_DIR`          | `/root`                    | Guest home, explicitly exported on each command; workspace is `<home>/workspace`. |
| `SUPERSERVE_IDLE_PAUSE_SEC`    | `900`                      | Provider active-time timeout; this is not a measure of guest inactivity.          |
| `SUPERSERVE_RETENTION_SEC`     | `2592000`                  | Provider auto-delete window in seconds after pause.                               |
| `SUPERSERVE_EGRESS_ALLOW`      | Unset                      | Comma-separated outbound allow rules.                                             |
| `SUPERSERVE_EGRESS_DENY`       | Unset                      | Comma-separated outbound deny rules.                                              |
| `SUPERSERVE_CONFIG_GENERATION` | Durable deployment counter | Explicit rollout ordering override.                                               |
| `SANDBOX_TIMEOUT_SEC`          | `600`                      | Default command deadline in seconds.                                              |

Background work can extend the provider timeout to QM's configured maximum background
job lifetime. Teardown leaves resident scope sandboxes to the provider timeout, so
ending one turn does not pause another concurrent turn. The next operation resumes
the sandbox with its disk intact. Scratch sandboxes are separate and deleted when
their last local handle closes, with provider time limits as a cleanup fallback.

## Updates and data retention

QM rediscovers sandboxes by scope metadata after a restart and verifies the provider's
actual egress policy before adoption. Changing the configured template replaces a
scope's sandbox and deletes its resident disk. Changing egress can also replace a
sandbox if the provider refuses the update while paused. Export needed files before
either change; automatic retention expiry and explicit scope destruction also delete
the disk.

Automatic configuration ordering reuses a generation for a previously seen build and
configuration. An older instance cannot overwrite a newer sandbox configuration.
For a rollback that must apply the older configuration, set
`SUPERSERVE_CONFIG_GENERATION` to a strictly increasing deployment sequence and keep
using that sequence for subsequent rollouts. Treat a rollback that changes template
or egress as the same potential disk replacement described above.

Command output is limited to 2 MiB per stream with a truncation notice; write larger
results to files. Background process sessions, binary file transfers, workspace
exports, and provider pause/resume are supported. Guest restart and the optional
browser engine are not provided by this backend/template.

## Tests

The backend tests use an in-process provider fake and need no account:

```sh
node --experimental-test-module-mocks --test test/superserve-*.test.ts
```

The template verifier boots and deletes a real sandbox and requires a Superserve key.
