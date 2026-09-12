import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Template, type TemplateInfo } from "@superserve/sdk";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");

export const TEMPLATE_NAME_PREFIX = "qm-agent";

export interface Connection {
  apiKey: string;
  baseUrl?: string;
}

export function resolveConnection(baseUrlFlag?: string): Connection {
  const apiKey = process.env.SUPERSERVE_API_KEY?.trim();
  if (!apiKey) throw new Error("SUPERSERVE_API_KEY is required");
  const baseUrl = (baseUrlFlag ?? process.env.SUPERSERVE_BASE_URL)?.trim();
  return baseUrl ? { apiKey, baseUrl } : { apiKey };
}

export function defaultRelease(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) throw new Error("package.json has no version");
  return pkg.version;
}

export function templateNameForRelease(release: string): string {
  const cleaned = release.trim().replace(/^v/, "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned)) {
    throw new Error(`release ${JSON.stringify(release)} is not a valid template name suffix`);
  }
  return `${TEMPLATE_NAME_PREFIX}-${cleaned}`;
}

export function fmtMs(ms: number): string {
  return ms < 10_000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export async function findTemplateByName(name: string, conn: Connection): Promise<TemplateInfo | undefined> {
  const matches = await Template.list({ ...conn, namePrefix: name });
  return matches.find((t) => t.name === name);
}
