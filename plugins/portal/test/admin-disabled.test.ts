import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const upstream = createServer((req: IncomingMessage, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ url: req.url }));
});
await new Promise<void>((r) => upstream.listen(0, r));
const upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;

process.env.PORTAL_PUBLIC_URL = "http://localhost:18198";
process.env.PORTAL_SESSION_SECRET = "admin-disabled-test-portal-secret";
process.env.CORE_SIGNING_SECRET = "admin-disabled-test-core-secret";
process.env.WEB_UI_UPSTREAM = upstreamUrl;
process.env.CORE_API_URL = upstreamUrl;
process.env.ADMIN_ENABLED = "0";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

test.after(() => {
  server.close();
  upstream.close();
});

test("portal 404s /admin when ADMIN_ENABLED=0, without probing admin status or the dead upstream default", async () => {
  const admin = await fetch(`${base}/admin/`, { redirect: "manual" });
  assert.equal(admin.status, 404);
});
