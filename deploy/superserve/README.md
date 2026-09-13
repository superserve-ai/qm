# Single-container tenant image

One image, one container, one tenant: `scripts/qm-tenant-entry.mjs` runs database migrations to completion, then supervises core, the combined web-ui (chat plus the admin module under `/admin`), and portal (the public front door, with the built-in sign-in broker embedded) inside a single container. Portal is the only process on the container port; core and web-ui are pinned to loopback. This is the workload a provisioner launches as one Cloud Run service per tenant.

```
container port (PORT, default 8080)
  └─ portal            0.0.0.0:8080   public front door, sessions, CSRF, proxies to the surfaces
       ├─ auth broker  127.0.0.1:8099 embedded in the portal process when AUTH_SIGNING_JWK is set
       ├─ web-ui       127.0.0.1:8082 chat surface; serves admin under /admin
       └─ core         127.0.0.1:8081 API, runs, Slack, sandboxes; Postgres + S3 backed
```

The provisioner must configure the Cloud Run service with CPU always allocated (not request-based) and at least one minimum instance: `config.backgroundWorkEnabled` defaults to `true`, and core's scheduler and Slack socket reconcilers (`src/index.ts`) run independently of inbound requests. Request-based CPU or a zero minimum would let the platform throttle or scale the container to zero between requests, stalling cron work and Slack delivery for idle tenants.

## Startup and health

1. `node src/migrate-main.ts` runs with core's environment. A non-zero exit stops the container before anything listens.
2. Core starts on `127.0.0.1:8081`; the supervisor polls `GET /healthz` there before continuing.
3. Web-ui starts on `127.0.0.1:8082` and is polled the same way.
4. Portal starts on `0.0.0.0:$PORT` and is polled at `/healthz`.

`GET /healthz` on the container port is served by portal and returns `200 {"ok":true}` only once every step above has completed, so it is the right target for the Cloud Run startup probe. Nothing answers on the container port before migrations have finished. `QM_READY_TIMEOUT_MS` (default `120000`) bounds each readiness wait; overrunning it exits the container.

Failure and shutdown:

- If any child exits, the supervisor sends `SIGTERM` to the rest and exits `1`; Cloud Run restarts the container. Stragglers are `SIGKILL`ed after 3 s, or after core's full drain and lease-release window when core is one of them.
- On `SIGTERM`/`SIGINT` the supervisor signals core first and keeps portal and web-ui serving until core has exited, so in-flight public requests are not reset while runs drain. Core drains workers for `SHUTDOWN_DRAIN_MS` (image default `1000`); if that stop wedges, core's own backstop fires 5 s later and it then spends up to 3 s releasing in-flight run leases. The supervisor waits for that whole sequence plus 1 s before `SIGKILL`, then exits `0`. Keep `SHUTDOWN_DRAIN_MS` at least 9 s under the service's termination grace period so the lease release completes before the platform kills the container; Cloud Run defaults to 10 s, which is why the image ships `1000`.
- The supervisor logs child lifecycle events only, prefixed `[tenant]`. It never prints environment values.

Core and web-ui do not read a bind address from their environment (`server.listen(PORT)` in `src/index.ts` and `plugins/web-ui/server/index.ts`), so the supervisor preloads `scripts/qm-tenant-loopback.mjs` into those two children. It rewrites any `listen(port)` without an explicit host to `127.0.0.1`. Portal is started without the shim.

## Environment contract

Values are read from the container environment. The supervisor derives the loopback wiring and the embedded-broker OIDC settings itself and only fills a derived value when the variable is not already set, so a provisioner can override any of them. Secret names come from `cli/src/secrets.ts` and `src/deployment/secret-schema.ts`; runtime behaviour from `src/config.ts`, `plugins/portal/src/index.ts`, `plugins/web-ui/server/index.ts` and `plugins/auth/src/config.ts`.

Web-ui and portal receive an allowlisted subset of the environment (their own `WEB_UI_*`/`ADMIN_*`/`PORTAL_*`/`OIDC_*`/`AUTH_*`/`SMTP_*` variables, the two shared signing secrets, and process basics such as `PATH`, `HOME`, `NODE_ENV`, proxy settings). Model keys, `DATABASE_URL`, sandbox tokens and every other core secret stay in the core process.

### Supervisor

| Variable              | Required | Notes                                                                                        |
| --------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `PORT`                | no       | Container port portal binds. Default `8080`; Cloud Run sets it.                              |
| `QM_CORE_PORT`        | no       | Loopback port for core. Default `8081`.                                                      |
| `QM_WEB_UI_PORT`      | no       | Loopback port for web-ui. Default `8082`.                                                    |
| `QM_READY_TIMEOUT_MS` | no       | Per-service readiness deadline. Default `120000`.                                            |
| `SHUTDOWN_DRAIN_MS`   | no       | Core's worker drain window on SIGTERM. Image default `1000`; QM's own default is `10000`.    |
| `AUTH_EMBEDDED`       | no       | `1`/`0` forces the embedded sign-in broker on/off. Unset: on when `AUTH_SIGNING_JWK` is set. |
| `ADMIN_ENABLED`       | no       | `0` turns the admin module off in web-ui and makes portal 404 on `/admin`. Default `1`.      |

The three port variables must each be a TCP port between 1 and 65535 and must differ from one
another; `8099` is reserved as well, but only while the embedded broker is running. The two
millisecond variables must fit a Node timer, and `SHUTDOWN_DRAIN_MS` leaves room for the nine
seconds the supervisor adds on top so core can finish its own backstop and release in-flight
run leases. The supervisor rejects anything else at startup with exit code 2 rather than
booting into a readiness timeout or killing core mid-drain.

### Shared identity and signing secrets

| Variable                 | Required | Consumers            | Notes                                                                                         |
| ------------------------ | -------- | -------------------- | --------------------------------------------------------------------------------------------- |
| `ORG_ID`                 | yes      | core, web-ui, portal | Tenant organisation id. Forwarded to the surfaces as `CORE_ORG_ID`.                           |
| `PUBLIC_WEB_URL`         | yes      | core, web-ui, portal | Public https origin of this tenant. Also becomes `WEB_UI_PUBLIC_URL` and `PORTAL_PUBLIC_URL`. |
| `CORE_SIGNING_SECRET`    | yes      | core, web-ui, portal | HMAC key shared by core and the surfaces. 32+ random bytes; must differ from every other key. |
| `PORTAL_IDENTITY_SECRET` | yes      | core, web-ui, portal | Signs portal-bound user identity. Distinct value.                                             |
| `CAPABILITY_SECRET`      | yes      | core                 | Signs scoped agent capabilities and egress grants. Distinct value.                            |
| `CONNECTOR_SECRET_KEY`   | yes      | core                 | Encrypts durable connector credentials. Distinct value.                                       |
| `SKILL_SIGNING_SECRET`   | yes      | core                 | Stable signing key for reviewed skills. Rotating it invalidates reviewed skills.              |
| `PORTAL_SESSION_SECRET`  | yes      | portal               | Cookie-signing secret. Must differ from `CORE_SIGNING_SECRET`; `qm admin-login` needs it too. |
| `ADMIN_GRANTS`           | yes      | core                 | `email:org_admin[,email:org_admin]`. Without it a fresh deployment has no reachable admin.    |
| `NODE_ENV`               | no       | all                  | Image default `production`, which turns on every strict check listed here.                    |
| `GIT_SHA`                | no       | all                  | Build metadata; set through the `GIT_SHA` build arg.                                          |

Generate each secret with `openssl rand -hex 32`. In production core rejects placeholders and weak values for `CORE_SIGNING_SECRET`, `CONNECTOR_SECRET_KEY` and `SKILL_SIGNING_SECRET`.

### Core: durable state

| Variable                | Required | Notes                                                                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | yes      | Postgres connection string. Migrations and core both use it.                                |
| `SESSION_STORE`         | no       | Defaulted to `postgres` by the supervisor when `DATABASE_URL` is set.                       |
| `RUN_STORE`             | no       | Defaulted to `postgres` by the supervisor when `DATABASE_URL` is set.                       |
| `SNAPSHOT_STORE`        | yes      | `s3` for hosted tenants (`local` writes under `DATA_DIR`, which is ephemeral on Cloud Run). |
| `TRANSFER_STORE`        | yes      | `s3`, same reasoning.                                                                       |
| `S3_BUCKET`             | yes      | Bucket for snapshots, transfers and file artifacts.                                         |
| `S3_REGION`             | yes      | Bucket region.                                                                              |
| `S3_PREFIX`             | no       | Key prefix inside the bucket, useful for one bucket shared across tenants.                  |
| `AWS_ACCESS_KEY_ID`     | yes      | Credentials for the S3 client (standard AWS SDK resolution).                                |
| `AWS_SECRET_ACCESS_KEY` | yes      |                                                                                             |
| `AWS_SESSION_TOKEN`     | no       | For temporary credentials.                                                                  |
| `AWS_REGION`            | no       | SDK default region; set it equal to `S3_REGION`.                                            |
| `AWS_ENDPOINT_URL_S3`   | no       | S3-compatible endpoint (MinIO, R2, GCS interop). Buckets are addressed virtual-host style.  |
| `DATA_DIR`              | no       | Scratch directory. Image default `/data`, owned by the `node` user.                         |
| `DATABASE_CA_CERT`      | no       | Extra PEM root CA for the Postgres connection.                                              |
| `DATABASE_POOL_URL`     | no       | Transaction-mode pooler URL.                                                                |
| `DATABASE_POOL_CA_CERT` | no       | PEM CA for the pooler.                                                                      |

### Core: agent runtime

| Variable                                                                                                                                                                                                            | Required          | Notes                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS`                                                                                                                                                                                                           | yes               | `pi`, `opencode`, `codex` or `claude`. `mock` (the unset default) answers with canned text and only warns in production.                                                                  |
| `MODEL_PROVIDER`                                                                                                                                                                                                    | yes               | `anthropic`, `openai` or `openrouter`. Selects which key below is mandatory.                                                                                                              |
| `ANTHROPIC_API_KEY`                                                                                                                                                                                                 | cond.             | Required when `MODEL_PROVIDER=anthropic`; optional fallback otherwise.                                                                                                                    |
| `OPENAI_API_KEY`                                                                                                                                                                                                    | cond.             | Required when `MODEL_PROVIDER=openai` or `HARNESS=codex` (unless `CODEX_AUTH_CREDENTIAL` is set).                                                                                         |
| `OPENROUTER_API_KEY`                                                                                                                                                                                                | cond.             | Required when `MODEL_PROVIDER=openrouter`.                                                                                                                                                |
| `PI_MODEL`                                                                                                                                                                                                          | no                | Model override for the pi harness.                                                                                                                                                        |
| `PUBLIC_API_URL`                                                                                                                                                                                                    | yes               | Core URL reachable from agent sandboxes. Required for `pi`, `opencode` and `codex`. Point it at the public portal origin only if portal forwards `/v1`; otherwise expose core separately. |
| `SANDBOX_BACKEND`                                                                                                                                                                                                   | yes               | Mandatory in production. Hosted tenants use `superserve`; core also accepts `aws`, `local`, `sprites`, `smolmachines`, `e2b`, `modal`, `porter`, `agent37`.                               |
| `SUPERSERVE_API_KEY` (secret), `SUPERSERVE_BASE_URL`, `SUPERSERVE_TEMPLATE`, `SUPERSERVE_NAME_PREFIX`, `SUPERSERVE_IDLE_PAUSE_SEC`, `SUPERSERVE_RETENTION_SEC`, `SUPERSERVE_EGRESS_ALLOW`, `SUPERSERVE_EGRESS_DENY` | with `superserve` | Superserve sandbox backend settings (see `.env.example`). The key is the tenant's own Superserve API key; the template is `qm-agent-<qm-release>`.                                        |
| `HARNESS_SECURITY_POSTURE`, `HARNESS_SHARING_POSTURE`                                                                                                                                                               | no                | Harness posture knobs from `.env.example`.                                                                                                                                                |
| `RATE_LIMIT_PER_WINDOW`, `RATE_LIMIT_WINDOW_MS`, `BUDGET_USD_PER_WINDOW`, `ORG_BUDGET_USD_PER_WINDOW`, `BUDGET_WINDOW_MS`                                                                                           | no                | Rate and budget limits.                                                                                                                                                                   |
| `DEPLOY_PROVIDER`                                                                                                                                                                                                   | no                | `docker` (default), `aws`, `fly`, `porter`. The default only warns that no Docker daemon is reachable; app publishing is unavailable in this image.                                       |
| `ORG_BRAND_SELF_LABEL`, `ORG_BRAND_ORG_NAME`                                                                                                                                                                        | no                | Branding. `ORG_BRAND_SELF_LABEL` also becomes portal's `AUTH_BRAND_NAME` when unset.                                                                                                      |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`                                                                                                                                                                                | no                | Slack runs inside core. Both or neither. `SLACK_SIGNING_SECRET` only for `SLACK_EVENTS_MODE=http`.                                                                                        |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`, `DROPBOX_OAUTH_CLIENT_ID` / `_SECRET`, `LINEAR_OAUTH_CLIENT_ID` / `_SECRET`                                                                                                   | no                | Connector OAuth apps; each secret is required when its client id is set.                                                                                                                  |

Superserve sandbox backend: set `SANDBOX_BACKEND=superserve` with `SUPERSERVE_API_KEY` (and `SUPERSERVE_TEMPLATE=qm-agent-<release>`); core constructs the backend lazily and only talks to the Superserve API on the first agent turn, so `/healthz` does not depend on it. `local` is the only backend that constructs without credentials; it shells out to a Docker daemon at first use, which this image does not have, so it is fit for the local harness only.

### Web-ui (chat and admin)

Set by the supervisor: `PORT`, `CORE_API_URL=http://127.0.0.1:8081`, `CORE_ORG_ID`, `ADMIN_BASE_PATH=/admin`, `ADMIN_ENABLED` (default `1`), `WEB_UI_PUBLIC_URL` (default `PUBLIC_WEB_URL`). Shared secrets from the table above: `CORE_SIGNING_SECRET`, `PORTAL_IDENTITY_SECRET`.

| Variable                                          | Required | Notes                                                                   |
| ------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `WEB_UI_PRINCIPALS`                               | no       | Comma-separated principal allowlist; unset lets any portal identity in. |
| `INBOX_USERS`, `LOOPS_USERS`                      | no       | Feature gates for the inbox and loops views.                            |
| `WEB_UI_FAVICON_EMOJI`                            | no       | Favicon override.                                                       |
| `STATE_FEED_RECONNECT_MS`, `WEB_DELIVERY_POLL_MS` | no       | Feed tuning.                                                            |

### Portal (public front door)

Set by the supervisor: `PORT` (container port), `CORE_API_URL`, `CORE_ORG_ID`, `WEB_UI_UPSTREAM=http://127.0.0.1:8082`, `ADMIN_ENABLED` (default `1`; portal 404s `/admin` when `0`), `ADMIN_UPSTREAM=http://127.0.0.1:8082/admin` (set only when admin is enabled), `PORTAL_PUBLIC_URL` (default `PUBLIC_WEB_URL`). Shared secrets: `CORE_SIGNING_SECRET`, `PORTAL_IDENTITY_SECRET`, `PORTAL_SESSION_SECRET`.

In production portal requires an https `PORTAL_PUBLIC_URL`, non-placeholder `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, `OIDC_JWKS_URI` for non-Slack issuers, and one trust boundary among `OIDC_ALLOWED_EMAILS`, `OIDC_ALLOWED_EMAIL_DOMAIN`, `PORTAL_EXPECTED_TEAM_ID`. With the embedded broker on, the supervisor fills all of the OIDC values.

| Variable                                                                                                                                                    | Required | Notes                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                                                                                                                      | cond.    | External IdP client. Derived from the broker when embedded auth is on.                                                      |
| `OIDC_ISSUER`, `OIDC_AUTH_ENDPOINT`, `OIDC_TOKEN_ENDPOINT`, `OIDC_USERINFO_ENDPOINT`, `OIDC_JWKS_URI`, `OIDC_SCOPES`, `OIDC_PRINCIPAL_CLAIM`, `OIDC_PROMPT` | cond.    | External IdP endpoints. Derived when embedded auth is on.                                                                   |
| `OIDC_ALLOWED_EMAILS`, `OIDC_ALLOWED_EMAIL_DOMAIN`, `PORTAL_EXPECTED_TEAM_ID`                                                                               | one      | Trust boundary. The first two are copied from `AUTH_ALLOWED_EMAILS` / `AUTH_ALLOWED_EMAIL_DOMAIN` when embedded auth is on. |
| `PORTAL_SESSION_TTL_S`, `PORTAL_SESSION_MAX_TTL_S`, `PORTAL_IMPERSONATE_TTL_S`                                                                              | no       | Session lifetimes.                                                                                                          |
| `PORTAL_XFF_TRUSTED_HOPS`                                                                                                                                   | no       | Set to `1` behind Cloud Run's load balancer so client IPs come from `X-Forwarded-For`.                                      |
| `PORTAL_COOKIE_DOMAIN`, `PORTAL_APPS_DOMAIN`, `DEPLOY_APPS_DOMAIN`                                                                                          | no       | Only for published-app subdomains.                                                                                          |
| `PORTAL_PLAYGROUND`, `PORTAL_DEPLOYMENTS_ENABLED`, `PORTAL_FAVICON_EMOJI`                                                                                   | no       | Feature flags.                                                                                                              |
| `PORTAL_LOCAL_AUTH_BYPASS`, `PORTAL_DEV_PRINCIPAL`                                                                                                          | no       | Refused in production; localhost development only.                                                                          |

### Embedded auth broker (in the portal process)

Enabled when `AUTH_SIGNING_JWK` is set (or `AUTH_EMBEDDED=1`). The supervisor sets `AUTH_EMBEDDED=1`, `AUTH_BROKER_UPSTREAM=http://127.0.0.1:8099`, `AUTH_BROKER_PREFIX=/idp`, `AUTH_ISSUER=<PUBLIC_WEB_URL>/idp`, `AUTH_CLIENT_ID=qm-portal`, `AUTH_REDIRECT_URI=<PUBLIC_WEB_URL>/auth/callback`, and the matching `OIDC_*` values, exactly as `cli/src/services.ts` `brokerWiring` does for the docker target. The broker's token, userinfo and JWKS endpoints stay on loopback; only its browser routes are reachable through portal under `/idp/`.

| Variable                                                                                                                                                                                                       | Required | Notes                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SIGNING_JWK`                                                                                                                                                                                             | yes      | P-256 private JWK (single line). Generate: `node -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"` |
| `AUTH_TOKEN_SECRET`                                                                                                                                                                                            | yes      | 32+ chars; seals sign-in links, codes and access tokens. Distinct from every other key.                                                                                                                                          |
| `AUTH_CLIENT_SECRET`                                                                                                                                                                                           | yes      | 32+ chars; the portal presents it at the token endpoint. Also copied to `OIDC_CLIENT_SECRET`.                                                                                                                                    |
| `AUTH_ALLOWED_EMAIL_DOMAIN` or `AUTH_ALLOWED_EMAILS`                                                                                                                                                           | one      | Who may sign in. `AUTH_ALLOWED_EMAILS` is also read by core to protect those principals.                                                                                                                                         |
| `AUTH_EMAIL_FROM`                                                                                                                                                                                              | yes      | Verified sender, e.g. `Acme <no-reply@example.com>`. Core reads it for invitations too.                                                                                                                                          |
| `AUTH_EMAIL_TRANSPORT`                                                                                                                                                                                         | no       | `resend` (default) or `smtp`.                                                                                                                                                                                                    |
| `RESEND_API_KEY`                                                                                                                                                                                               | cond.    | For `resend`. Core also uses it for invitation email.                                                                                                                                                                            |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_TLS`                                                                                                                                         | cond.    | For `smtp`.                                                                                                                                                                                                                      |
| `AUTH_BRAND_NAME`                                                                                                                                                                                              | no       | Sign-in page brand; defaults to `ORG_BRAND_SELF_LABEL`.                                                                                                                                                                          |
| `AUTH_LINK_TTL_S`, `AUTH_CODE_TTL_S`, `AUTH_ACCESS_TTL_S`, `AUTH_REQUEST_TTL_S`, `AUTH_SESSION_IDLE_S`, `AUTH_SESSION_ABSOLUTE_S`, `AUTH_SEND_LIMIT_PER_EMAIL`, `AUTH_SEND_LIMIT_PER_IP`, `AUTH_SEND_WINDOW_S` | no       | Lifetimes and rate limits.                                                                                                                                                                                                       |

With embedded auth off, portal expects an external OIDC provider and `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` become operator-supplied.

## Building

```sh
docker build -f deploy/superserve/Dockerfile --build-arg GIT_SHA=$(git rev-parse HEAD) -t qm-tenant:local .
```

The image follows `deploy/core/Dockerfile` and the plugin Dockerfiles: `node:24-alpine` (same digest), `npm ci --omit=dev` for core, web-ui and portal, a separate build stage for web-ui's Vite bundle, auth resolving its dependencies through portal's `node_modules`, non-root `node` user, `EXPOSE 8080`. It does not include `docker-cli` (no daemon in Cloud Run) and skips the `npm audit` step of the core image; run the audit in CI instead.

Measured on this branch (Docker Desktop, Apple Silicon, local compose Postgres and MinIO): image size 671 MB; cold start from `docker run` to the first `200` on `/healthz`, migrations included, 13.8 to 14.4 s across three starts; killing the core child produced a container exit of `1` within 0.4 to 0.5 s; `docker stop` returned in about 0.5 s with exit `0` and the drain lines in the log.

## Running locally

Backing services and the tenant container run on the `qm-superserve` compose network. Postgres is also published on `127.0.0.1:55432` and MinIO on `127.0.0.1:59000` (console `59001`).

```sh
docker compose -f deploy/superserve/compose.yaml up -d   # minio-init is a one-shot bucket creator; it exits 0
cp deploy/superserve/env.example deploy/superserve/.env
# fill the six *_SECRET values (openssl rand -hex 32); optionally the AUTH_* block for the broker
docker run --rm --name qm-tenant \
  --network qm-superserve -p 127.0.0.1:8080:8080 \
  --env-file deploy/superserve/.env qm-tenant:local
```

The harness runs with `NODE_ENV=development` because portal refuses an http `PORTAL_PUBLIC_URL` in production; everything else matches the production wiring. `DATABASE_URL` in the example uses `postgres:5432` over the compose network, which resolves on every Docker engine; `host.docker.internal:55432` reaches the published port instead, but only where the daemon defines that name. MinIO needs the compose network because the SDK addresses the bucket virtual-host style as `qm-tenant.minio` (compose declares that alias; S3 bucket names must be at least three characters).

Sign in as the admin named in `ADMIN_GRANTS`:

```sh
node cli/bin/qm.ts admin-login --env-file deploy/superserve/.env
```

Open the printed `http://localhost:8080/auth/admin-login#token=...` link (http is accepted on localhost only; the link is single-use and expires after five minutes). Then `http://localhost:8080/` is the chat surface and `http://localhost:8080/admin/` the admin module.

Checks worth repeating after changes:

```sh
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/healthz     # 200 once portal is up
curl -s localhost:8081/healthz                                        # connection refused: core is loopback only
docker exec qm-tenant pkill -f /app/src/index.ts                      # kill core: container exits 1 within 5 s
docker stop -t 20 qm-tenant                                           # drain log, exit 0
```

Tear down with `docker compose -f deploy/superserve/compose.yaml down -v`.
