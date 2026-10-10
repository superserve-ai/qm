import type { VerifiedSandboxIdentity } from "../runs/sandbox-provisions.ts";

const fields = {
  tenantId: "QM_VERIFIED_TENANT_ID",
  teamId: "QM_VERIFIED_TEAM_ID",
  machinePrincipalId: "QM_VERIFIED_MACHINE_PRINCIPAL_ID",
  manifestId: "QM_VERIFIED_MANIFEST_ID",
  releaseImage: "QM_VERIFIED_RELEASE_IMAGE",
} as const;

export function verifiedSandboxIdentity(env: NodeJS.ProcessEnv): VerifiedSandboxIdentity | undefined {
  if (!Object.values(fields).some((name) => env[name] !== undefined)) return undefined;
  const identity = Object.fromEntries(
    Object.entries(fields).map(([key, name]) => {
      const value = env[name];
      if (!value || value.length > 512 || /[\x00-\x20\x7f]/.test(value))
        throw new Error("Complete verified sandbox startup identity is required");
      return [key, value];
    }),
  ) as unknown as VerifiedSandboxIdentity;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    ![identity.tenantId, identity.teamId, identity.manifestId].every((id) => uuid.test(id)) ||
    !/^\d{12}\.dkr\.ecr\.us-west-2\.amazonaws\.com\/qm\/tenant@sha256:[a-f0-9]{64}$/.test(identity.releaseImage)
  )
    throw new Error("Invalid verified sandbox startup identity");
  return Object.freeze(identity);
}
