# Superserve templates

`qm-agent.ts` builds the **`qm-agent-<release>`** Superserve template: the pre-baked
Firecracker VM image that QM scope sandboxes boot from when `SANDBOX_BACKEND=superserve`.
Sandboxes created from a ready template come up in seconds with the toolset already
installed, instead of installing it on every provision.

The template mirrors the tool inventory of `fly/Dockerfile` (the shared sandbox base
image) adapted to a Superserve BuildSpec on `ubuntu:24.04`, with the same pinned versions.

## What the template contains

| Layer      | Contents                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base       | `ubuntu:24.04` (Superserve build VMs are linux/amd64)                                                                                                                                                  |
| apt        | bash, coreutils (incl. `timeout`), findutils, grep, sed, gawk, git, curl, wget, jq, unzip, tar, xz-utils, openssh-client, ca-certificates, gnupg                                                       |
| Python     | python3, python3-venv, python3-pip; a venv at `/opt/agent-venv` with pip upgraded, exported as `VIRTUAL_ENV`; `python`, `python3`, `pip`, `pip3` on `PATH` resolve to it via `/usr/local/bin` wrappers |
| Node       | Node + npm from the checksum-verified nodejs.org tarball, pinned to the version `fly/Dockerfile` gets from its digest-pinned `node:24-slim` stage                                                      |
| Agent CLIs | `claude` (`@anthropic-ai/claude-code`) and `codex` (`@openai/codex`), global npm installs pinned to the Dockerfile versions                                                                            |
| Other CLIs | `gh` (GitHub CLI) and AWS CLI v2, checksum-verified downloads pinned to the Dockerfile versions                                                                                                        |
| Tools      | `/usr/local/bin/x-api` (copied from `fly/tools/x-api` at build time)                                                                                                                                   |
| Runtime    | Commands run as `root`; the exec daemon injects `HOME=/home/user` and its own `PATH`, so the backend exports `HOME=/root` (or `SUPERSERVE_HOME_DIR`) on every command; default cwd `/root/workspace`   |

Default VM shape is 2 vCPU / 2048 MiB memory / 8192 MiB disk (`--vcpu`, `--memory-mib`,
`--disk-mib` override). Sandboxes inherit the shape from the template.

Deliberately **not** in the template:

- Per-deployment tools and skills: the backend materializes those at provision time.
- `nftables`: egress is not enforced inside the VM on Superserve.
- A `PATH` override: the exec daemon supplies its own `PATH` and `HOME` at runtime, so template
  `env` steps for those are ignored (other `env` steps, e.g. `VIRTUAL_ENV`, do carry through).
  The backend discovers `$HOME` per session, so scope workspaces land in `$HOME/workspace`.
- The optional browser engine (`INSTALL_BROWSER_ENGINE=1` in the Dockerfile). The Dockerfile
  relies on Debian's apt `chromium`; on Ubuntu 24.04 that package is a snap stub that does
  not run in a VM without snapd, so a different install path is needed before this can be
  offered as a build flag.

## Build it for a release

```sh
export SUPERSERVE_API_KEY=ss_live_...
node superserve/templates/qm-agent.ts --release 0.1.0 --wait
```

Export `SUPERSERVE_BASE_URL` (or pass `--base-url`) to build against a non-production API.

- `--release` is required and must be the QM release tag the deployment runs (the root
  `package.json` version does not track releases); the template is named `qm-agent-<release>`.
- `--wait` streams build logs and blocks until the build is ready (or fails with a
  `BuildError` code such as `step_failed`). Without it the build is queued and the script
  returns immediately.
- The script is idempotent: if `qm-agent-<release>` already exists and is ready it prints the
  template and exits 0. Pass `--force` to delete and rebuild it. A previously failed template
  with the same name is deleted and rebuilt automatically.
- `--base-url` overrides `SUPERSERVE_BASE_URL`.

Template names are unique per team, so one build per release per Superserve team is enough.
Bumping a pinned CLI version in `qm-agent.ts` for an already-built release requires `--force`.

## How the backend picks it

Set `SUPERSERVE_TEMPLATE=qm-agent-<release>` on the QM deployment (alongside
`SUPERSERVE_API_KEY`, and `SUPERSERVE_BASE_URL` if not using production). Every scope and
scratch sandbox the Superserve backend creates is then booted `fromTemplate` that name.
`SUPERSERVE_TEMPLATE` is mandatory: core refuses to start with `SANDBOX_BACKEND=superserve`
and no template, because Superserve's stock image ships only `ca-certificates`, `curl`, and
`git`, which is not enough for an agent turn.

## Verify

```sh
node superserve/templates/verify-qm-agent.ts --release 0.1.0
```

The verifier boots a throwaway sandbox from the template, measures cold boot to first exec,
prints `$HOME`, `whoami`, `uname -a`, `PATH`, runs a `command -v` inventory of every expected
tool plus `--version` for each CLI, checks that `timeout` and the venv behave the way the
backend expects, then kills the sandbox. An interrupt (Ctrl-C or `SIGTERM`) kills it on the
way out too, so a cancelled run does not leave a sandbox running and billing. `--keep` keeps it
alive for inspection and arms a one-hour auto-delete window instead of killing it; without
`--keep` the sandbox is also configured to delete itself the moment it pauses, so even a
`SIGKILL`ed verifier cannot strand it. It exits non-zero if any expected tool is missing.
