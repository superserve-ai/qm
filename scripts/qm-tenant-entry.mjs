#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOPBACK_SHIM = pathToFileURL(join(ROOT, "scripts", "qm-tenant-loopback.mjs")).href;
const env = process.env;

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MAX_TIMER_MS = 2_147_483_647;
const FAILURE_GRACE_MS = 3_000;
const DRAIN_BACKSTOP_MS = 5_000;
const LEASE_RELEASE_MS = 3_000;
const KILL_MARGIN_MS = 1_000;
const SHUTDOWN_BACKSTOP_MS = DRAIN_BACKSTOP_MS + LEASE_RELEASE_MS + KILL_MARGIN_MS;

const PUBLIC_PORT = portEnv("PORT", 8080);
const CORE_PORT = portEnv("QM_CORE_PORT", 8081);
const WEB_UI_PORT = portEnv("QM_WEB_UI_PORT", 8082);
const BROKER_PORT = 8099;
const READY_TIMEOUT_MS = intEnv("QM_READY_TIMEOUT_MS", 120_000, 0, MAX_TIMER_MS);
const DRAIN_MS = intEnv("SHUTDOWN_DRAIN_MS", 10_000, 0, MAX_TIMER_MS - SHUTDOWN_BACKSTOP_MS);

const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_UI_URL = `http://127.0.0.1:${WEB_UI_PORT}`;
const PORTAL_URL = `http://127.0.0.1:${PUBLIC_PORT}`;

const REQUIRED = ["ORG_ID", "PUBLIC_WEB_URL", "DATABASE_URL"];

const COMMON_PASSTHROUGH = [
  "PATH",
  "HOME",
  "HOSTNAME",
  "TZ",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "NODE_ENV",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "K_SERVICE",
  "K_REVISION",
  "K_CONFIGURATION",
  "GIT_SHA",
  "CORE_SIGNING_SECRET",
  "PORTAL_IDENTITY_SECRET",
  "DEPLOY_APPS_DOMAIN",
  "BRANDING_DEBUG",
];
const WEB_UI_PASSTHROUGH = {
  names: [...COMMON_PASSTHROUGH, "INBOX_USERS", "LOOPS_USERS", "STATE_FEED_RECONNECT_MS", "WEB_DELIVERY_POLL_MS"],
  prefixes: ["WEB_UI_", "ADMIN_"],
};
const PORTAL_PASSTHROUGH = {
  names: [...COMMON_PASSTHROUGH, "RESEND_API_KEY", "USER"],
  prefixes: ["PORTAL_", "OIDC_", "AUTH_", "SMTP_"],
};

const children = new Map();
let stagedDrain = false;
let shuttingDown = false;
let exitCode = 0;
let killTimer;

function log(message) {
  console.log(`[tenant] ${message}`);
}

function warn(message) {
  console.error(`[tenant] ${message}`);
}

function intEnv(name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    warn(`${name} must be an integer between ${min} and ${max}`);
    process.exit(2);
  }
  return value;
}

function portEnv(name, fallback) {
  return intEnv(name, fallback, MIN_PORT, MAX_PORT);
}

function isSet(name) {
  return typeof env[name] === "string" && env[name].trim() !== "";
}

function pick(source, { names, prefixes }) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (names.includes(key) || prefixes.some((prefix) => key.startsWith(prefix))) out[key] = value;
  }
  return out;
}

function withDefaults(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined || target[key].trim() === "") target[key] = value;
  }
  return target;
}

function loopbackOptions(base) {
  const existing = base.NODE_OPTIONS?.trim();
  return {
    NODE_OPTIONS: `${existing ? `${existing} ` : ""}--import=${LOOPBACK_SHIM}`,
    QM_LOOPBACK_ONLY: "1",
  };
}

function authEmbedded() {
  const explicit = env.AUTH_EMBEDDED?.trim();
  if (explicit === "0") return false;
  if (explicit === "1") return true;
  return isSet("AUTH_SIGNING_JWK");
}

function adminEnabled() {
  return env.ADMIN_ENABLED?.trim() !== "0";
}

function publicBase() {
  return env.PUBLIC_WEB_URL.trim().replace(/\/$/, "");
}

function coreEnv() {
  const out = { ...env, PORT: String(CORE_PORT), ...loopbackOptions(env) };
  const defaults = { WEB_UI_PUBLIC_URL: publicBase(), DATA_DIR: "/data" };
  if (isSet("DATABASE_URL")) Object.assign(defaults, { SESSION_STORE: "postgres", RUN_STORE: "postgres" });
  return withDefaults(out, defaults);
}

function webUiEnv() {
  const out = pick(env, WEB_UI_PASSTHROUGH);
  Object.assign(out, {
    PORT: String(WEB_UI_PORT),
    CORE_API_URL: CORE_URL,
    CORE_ORG_ID: env.ORG_ID,
    ADMIN_BASE_PATH: "/admin",
    ADMIN_ENABLED: adminEnabled() ? "1" : "0",
    ...loopbackOptions(out),
  });
  return withDefaults(out, { WEB_UI_PUBLIC_URL: publicBase() });
}

function portalEnv() {
  const base = publicBase();
  const out = pick(env, PORTAL_PASSTHROUGH);
  Object.assign(out, {
    PORT: String(PUBLIC_PORT),
    CORE_API_URL: CORE_URL,
    CORE_ORG_ID: env.ORG_ID,
    WEB_UI_UPSTREAM: WEB_UI_URL,
    ADMIN_ENABLED: adminEnabled() ? "1" : "0",
  });
  if (adminEnabled()) out.ADMIN_UPSTREAM = `${WEB_UI_URL}/admin`;
  const defaults = { PORTAL_PUBLIC_URL: base };
  if (isSet("ORG_BRAND_SELF_LABEL")) defaults.AUTH_BRAND_NAME = env.ORG_BRAND_SELF_LABEL;
  if (authEmbedded()) {
    const issuer = `${base}/idp`;
    const broker = `http://127.0.0.1:${BROKER_PORT}`;
    out.AUTH_EMBEDDED = "1";
    Object.assign(defaults, {
      AUTH_BROKER_UPSTREAM: broker,
      AUTH_BROKER_PREFIX: "/idp",
      AUTH_ISSUER: issuer,
      AUTH_CLIENT_ID: "qm-portal",
      AUTH_REDIRECT_URI: `${base}/auth/callback`,
      OIDC_CLIENT_ID: "qm-portal",
      OIDC_ISSUER: issuer,
      OIDC_AUTH_ENDPOINT: `${issuer}/authorize`,
      OIDC_TOKEN_ENDPOINT: `${broker}/token`,
      OIDC_USERINFO_ENDPOINT: `${broker}/userinfo`,
      OIDC_JWKS_URI: `${broker}/.well-known/jwks.json`,
      OIDC_SCOPES: "openid email",
      OIDC_PRINCIPAL_CLAIM: "email",
    });
    if (isSet("AUTH_CLIENT_SECRET")) defaults.OIDC_CLIENT_SECRET = env.AUTH_CLIENT_SECRET;
    if (isSet("AUTH_ALLOWED_EMAILS")) defaults.OIDC_ALLOWED_EMAILS = env.AUTH_ALLOWED_EMAILS;
    if (isSet("AUTH_ALLOWED_EMAIL_DOMAIN")) defaults.OIDC_ALLOWED_EMAIL_DOMAIN = env.AUTH_ALLOWED_EMAIL_DOMAIN;
  } else {
    delete out.AUTH_EMBEDDED;
  }
  return withDefaults(out, defaults);
}

function spawnChild(name, cwd, entry, childEnv) {
  const child = spawn(process.execPath, [join(cwd, entry)], { cwd, env: childEnv, stdio: "inherit" });
  children.set(name, child);
  log(`${name} started (pid ${child.pid})`);
  child.on("error", (error) => {
    children.delete(name);
    fail(`${name} could not be spawned: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    children.delete(name);
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (shuttingDown) {
      log(`${name} exited (${how})`);
      if (!signal && code !== 0) exitCode ||= 1;
      if (stagedDrain && name === "core") {
        stagedDrain = false;
        log("core drained; stopping the public surfaces");
        signalAll("SIGTERM");
      }
      if (children.size === 0) finish();
      return;
    }
    fail(`${name} exited unexpectedly (${how})`);
  });
  return child;
}

function runToCompletion(name, cwd, entry, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(cwd, entry)], { cwd, env: childEnv, stdio: "inherit" });
    children.set(name, child);
    log(`${name} started (pid ${child.pid})`);
    child.on("error", (error) => {
      children.delete(name);
      warn(`${name} could not be spawned: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      children.delete(name);
      log(`${name} finished (${signal ? `signal ${signal}` : `code ${code}`})`);
      if (shuttingDown && children.size === 0) finish();
      resolve(signal ? 1 : (code ?? 1));
    });
  });
}

async function waitHealthy(name, url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!shuttingDown) {
    const ok = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) {
      log(`${name} healthy`);
      return true;
    }
    if (Date.now() > deadline) {
      fail(`${name} did not report healthy within ${READY_TIMEOUT_MS}ms`);
      return false;
    }
    await sleep(250);
  }
  return false;
}

function signalAll(signal) {
  for (const [name, child] of children) {
    try {
      child.kill(signal);
    } catch (error) {
      warn(`${name}: ${signal} failed: ${error.message}`);
    }
  }
}

function terminate(code, graceMs, staged = false) {
  if (shuttingDown) return;
  shuttingDown = true;
  exitCode = code;
  if (children.size === 0) return finish();
  log(`stopping ${[...children.keys()].join(", ")} (grace ${graceMs}ms)`);
  stagedDrain = staged && children.has("core");
  if (stagedDrain) {
    children.get("core").kill("SIGTERM");
  } else {
    signalAll("SIGTERM");
  }
  killTimer = setTimeout(() => {
    if (children.size === 0) return;
    warn(`${[...children.keys()].join(", ")} still running after ${graceMs}ms; sending SIGKILL`);
    signalAll("SIGKILL");
    setTimeout(finish, 500).unref();
  }, graceMs);
  killTimer.unref();
}

function fail(message) {
  warn(message);
  terminate(1, children.has("core") ? DRAIN_MS + SHUTDOWN_BACKSTOP_MS : FAILURE_GRACE_MS);
}

function finish() {
  clearTimeout(killTimer);
  log(`exiting with code ${exitCode}`);
  process.exit(exitCode);
}

function shutdown(signal) {
  log(`${signal} received; draining (SHUTDOWN_DRAIN_MS=${DRAIN_MS})`);
  terminate(0, DRAIN_MS + SHUTDOWN_BACKSTOP_MS, true);
}

function slackAccountsRequestHttpEvents() {
  const raw = env.SLACK_ACCOUNTS?.trim();
  if (!raw) return false;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.some(
      (entry) => typeof entry === "object" && entry !== null && String(entry.eventsMode ?? "").trim() === "http",
    )
  );
}

async function main() {
  const missing = REQUIRED.filter((name) => !isSet(name));
  if (missing.length) {
    warn(`missing required environment: ${missing.join(", ")}`);
    process.exit(2);
  }
  if (env.SLACK_EVENTS_MODE?.trim() === "http" || slackAccountsRequestHttpEvents()) {
    warn(
      "SLACK_EVENTS_MODE=http is not supported by this image: only portal is public and it does not forward /slack/events; use Slack socket mode",
    );
    process.exit(2);
  }
  const embeddedAuth = authEmbedded();
  const ports = embeddedAuth
    ? [PUBLIC_PORT, CORE_PORT, WEB_UI_PORT, BROKER_PORT]
    : [PUBLIC_PORT, CORE_PORT, WEB_UI_PORT];
  if (new Set(ports).size !== ports.length) {
    const names = `PORT, QM_CORE_PORT, QM_WEB_UI_PORT${embeddedAuth ? ` and the broker port ${BROKER_PORT}` : ""}`;
    warn(`${names} must all differ`);
    process.exit(2);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const core = coreEnv();
  log(
    `tenant ${env.ORG_ID}: portal :${PUBLIC_PORT} (public), core 127.0.0.1:${CORE_PORT}, ` +
      `web-ui 127.0.0.1:${WEB_UI_PORT}, embedded auth ${embeddedAuth ? "on" : "off"}`,
  );

  const migrated = await runToCompletion("migrate", ROOT, "src/migrate-main.ts", core);
  if (shuttingDown) return;
  if (migrated !== 0) {
    warn("migrations failed; refusing to start services");
    exitCode = 1;
    return finish();
  }

  spawnChild("core", ROOT, "src/index.ts", core);
  if (!(await waitHealthy("core", `${CORE_URL}/healthz`))) return;

  spawnChild("web-ui", join(ROOT, "plugins", "web-ui"), "server/index.ts", webUiEnv());
  if (!(await waitHealthy("web-ui", `${WEB_UI_URL}/healthz`))) return;

  spawnChild("portal", join(ROOT, "plugins", "portal"), "src/index.ts", portalEnv());
  if (!(await waitHealthy("portal", `${PORTAL_URL}/healthz`))) return;

  log(`ready: portal is serving ${publicBase()} on :${PUBLIC_PORT}`);
}

main().catch((error) => fail(`supervisor error: ${error instanceof Error ? error.message : String(error)}`));
