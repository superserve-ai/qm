# Agent template

`qm-agent.ts` builds the `qm-agent-<release>` template used by the Superserve
sandbox backend.

## Contents

The template uses `ubuntu:24.04` on linux/amd64 and includes:

- Shell and file utilities, Git, curl, jq, and SSH.
- Node and npm, Python with a virtual environment at `/opt/agent-venv`.
- Coding-agent CLIs, `gh`, `aws`, and `x-api`.

Tool versions are pinned in the build script. Downloaded Node and CLI archives
are checksum-verified. Python and pip wrappers select the virtual environment
regardless of the exec environment's `PATH`. Commands run as root; QM sets `HOME`
to `SUPERSERVE_HOME_DIR` (default `/root`) and uses `<home>/workspace`.

Deployment tools and skills are installed during provisioning. The optional
browser engine is not included.

The default Superserve sandbox has 2 vCPUs, 2048 MiB memory, and 8192 MiB disk. Override these with
`--vcpu`, `--memory-mib`, and `--disk-mib` when building.

## Build

```sh
export SUPERSERVE_API_KEY=your-superserve-api-key
node superserve/templates/qm-agent.ts --release 0.1.0 --wait
```

`--release` names the template; use the release tag your deployment runs.
`--wait` streams logs until the build completes. Without it, the script returns
after queuing the build. Use `--base-url` or `SUPERSERVE_BASE_URL` to override the
API endpoint.

A ready template with the same name is reused. Failed builds are replaced;
`--force` also replaces a ready template. Names are unique within a team.

Set `SUPERSERVE_TEMPLATE=qm-agent-<release>` on core after the build succeeds.
The backend requires a ready template with this toolchain.

Rebuilding under the same name does not update existing sandboxes. Changing
`SUPERSERVE_TEMPLATE` to a different name replaces them and deletes their resident
files. Export needed files first; see [updates and retention](../../docs/superserve.md#updates-and-retention).

## Verify

```sh
node superserve/templates/verify-qm-agent.ts --release 0.1.0
```

The verifier creates a sandbox, checks its tools, workspace, Python environment,
and command timeout behavior, then deletes it. It exits nonzero if verification
or cleanup fails. `--template` selects a template directly instead of by release.

`--keep` retains the sandbox for inspection and schedules deletion one hour after
it pauses. Otherwise, automatic deletion on pause backs up explicit cleanup,
including when the verifier is interrupted.
