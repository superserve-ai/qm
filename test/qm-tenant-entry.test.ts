import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY = join(import.meta.dirname, "../scripts/qm-tenant-entry.mjs");
const ENTRY_TIMEOUT_MS = 30_000;

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  ORG_ID: "test-org",
  PUBLIC_WEB_URL: "https://example.com",
  DATABASE_URL: "postgres://qm:qm@127.0.0.1:1/qm",
};

interface EntryRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runEntry(overrides: Record<string, string>): Promise<EntryRun> {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...BASE_ENV, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(ENTRY_TIMEOUT_MS),
    killSignal: "SIGKILL",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.on("error", (error) => (stderr += `${error.message}\n`));
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

for (const name of ["PORT", "QM_CORE_PORT", "QM_WEB_UI_PORT"]) {
  for (const value of ["0", "-1", "65536", "70000", "8080.5", "abc"]) {
    test(`tenant entry rejects ${name}=${value}`, async () => {
      const { code, stderr } = await runEntry({ [name]: value });
      assert.equal(code, 2);
      assert.match(stderr, new RegExp(`${name} must be an integer between 1 and 65535`));
    });
  }
}

test("tenant entry rejects a ready timeout that overflows a node timer", async () => {
  const { code, stderr } = await runEntry({ QM_READY_TIMEOUT_MS: "2147483648" });
  assert.equal(code, 2);
  assert.match(stderr, /QM_READY_TIMEOUT_MS must be an integer between 0 and 2147483647/);
});

test("tenant entry rejects a drain window that would overflow the shutdown timer", async () => {
  const { code, stderr } = await runEntry({ SHUTDOWN_DRAIN_MS: "2147483647" });
  assert.equal(code, 2);
  assert.match(stderr, /SHUTDOWN_DRAIN_MS must be an integer between 0 and 2147474647/);
});

function millis(source: string, pattern: RegExp): number {
  const raw = pattern.exec(source)?.[1];
  assert.ok(raw, `no match for ${pattern} in source`);
  return Number(raw.replaceAll("_", ""));
}

test("tenant entry waits out core's drain and its lease-release backstop", () => {
  const entry = readFileSync(ENTRY, "utf8");
  const core = readFileSync(join(import.meta.dirname, "../src/wiring.ts"), "utf8");
  assert.match(entry, /terminate\(0, DRAIN_MS \+ SHUTDOWN_BACKSTOP_MS, true\)/);
  assert.match(entry, /terminate\(1, children\.has\("core"\) \? DRAIN_MS \+ SHUTDOWN_BACKSTOP_MS : FAILURE_GRACE_MS\)/);
  assert.equal(
    millis(entry, /const DRAIN_BACKSTOP_MS = ([\d_]+);/),
    millis(core, /\}, shutdownDrainMs \+ ([\d_]+)\);/),
  );
  assert.equal(
    millis(entry, /const LEASE_RELEASE_MS = ([\d_]+);/),
    millis(core, /releaseInFlightRuns\(\), sleep\(([\d_]+),/),
  );
  assert.ok(millis(entry, /const KILL_MARGIN_MS = ([\d_]+);/) > 0);
});

test("the image's drain default leaves the shutdown sequence inside a 10s termination grace", () => {
  const entry = readFileSync(ENTRY, "utf8");
  const dockerfile = readFileSync(join(import.meta.dirname, "../deploy/superserve/Dockerfile"), "utf8");
  const backstop =
    millis(entry, /const DRAIN_BACKSTOP_MS = ([\d_]+);/) +
    millis(entry, /const LEASE_RELEASE_MS = ([\d_]+);/) +
    millis(entry, /const KILL_MARGIN_MS = ([\d_]+);/);
  const drain = millis(dockerfile, /ENV SHUTDOWN_DRAIN_MS=([\d_]+)/);
  assert.ok(drain + backstop <= 10_000, `drain ${drain} + backstop ${backstop} exceeds a 10s grace`);
});

test("tenant entry accepts the top of the port range", async () => {
  const { code, stdout, stderr } = await runEntry({ PORT: "65535", QM_CORE_PORT: "65534", QM_WEB_UI_PORT: "65533" });
  assert.doesNotMatch(stderr, /must be an integer between/);
  assert.match(stdout, /portal :65535 \(public\)/);
  assert.equal(code, 1);
});

test("tenant entry leaves the broker port free when embedded auth is off", async () => {
  const { code, stdout, stderr } = await runEntry({
    PORT: "45080",
    QM_CORE_PORT: "45081",
    QM_WEB_UI_PORT: "8099",
    AUTH_EMBEDDED: "0",
  });
  assert.doesNotMatch(stderr, /must all differ/);
  assert.match(stdout, /embedded auth off/);
  assert.equal(code, 1);
});

test("tenant entry rejects a web-ui port that collides with the broker when embedded auth is on", async () => {
  const { code, stderr } = await runEntry({
    PORT: "45080",
    QM_CORE_PORT: "45081",
    QM_WEB_UI_PORT: "8099",
    AUTH_EMBEDDED: "1",
  });
  assert.equal(code, 2);
  assert.match(stderr, /and the broker port 8099 must all differ/);
});

test("tenant entry reads a padded AUTH_EMBEDDED as embedded auth", async () => {
  const { code, stdout, stderr } = await runEntry({
    PORT: "45080",
    QM_CORE_PORT: "45081",
    QM_WEB_UI_PORT: "8099",
    AUTH_EMBEDDED: " 1 ",
  });
  assert.equal(code, 2);
  assert.match(stderr, /and the broker port 8099 must all differ/);
  assert.doesNotMatch(stdout, /embedded auth off/);
});

test("tenant entry rejects a padded SLACK_EVENTS_MODE=http", async () => {
  const { code, stderr } = await runEntry({ SLACK_EVENTS_MODE: " http " });
  assert.equal(code, 2);
  assert.match(stderr, /SLACK_EVENTS_MODE=http is not supported by this image/);
});

test("tenant entry rejects an account-scoped eventsMode=http in SLACK_ACCOUNTS", async () => {
  const { code, stderr } = await runEntry({
    SLACK_ACCOUNTS: JSON.stringify([{ id: "a", eventsMode: " http " }]),
  });
  assert.equal(code, 2);
  assert.match(stderr, /SLACK_EVENTS_MODE=http is not supported by this image/);
});

test("tenant entry rejects colliding service ports", async () => {
  const { code, stderr } = await runEntry({ PORT: "45080", QM_CORE_PORT: "45080", AUTH_EMBEDDED: "0" });
  assert.equal(code, 2);
  assert.match(stderr, /PORT, QM_CORE_PORT, QM_WEB_UI_PORT must all differ/);
});
