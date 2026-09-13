#!/usr/bin/env bash
set -euo pipefail

image="${TENANT_IMAGE:-qm-tenant:runtime-smoke}"
root="$(git rev-parse --show-toplevel)"
suffix="${GITHUB_RUN_ID:-$$}"
network="qm-tenant-smoke-$suffix"
postgres="qm-tenant-smoke-pg-$suffix"
container="qm-tenant-smoke-$suffix"

cleanup() {
  status=$?
  trap - EXIT
  docker rm -f "$container" "$postgres" > /dev/null 2>&1 || true
  docker network rm "$network" > /dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

cd "$root"
if [[ -z "${TENANT_IMAGE:-}" ]]; then
  docker build -f deploy/superserve/Dockerfile -t "$image" .
fi

docker network create "$network" > /dev/null
docker run -d --name "$postgres" --network "$network" \
  -e POSTGRES_USER=qm -e POSTGRES_PASSWORD=qm -e POSTGRES_DB=qm postgres:16 > /dev/null

for _ in {1..60}; do
  docker exec "$postgres" pg_isready -U qm -d qm > /dev/null 2>&1 && break
  sleep 1
done
docker exec "$postgres" pg_isready -U qm -d qm > /dev/null

signing_jwk="$(docker run --rm --entrypoint node "$image" -e "const {generateKeyPairSync}=require('node:crypto');process.stdout.write(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))")"

docker run -d --name "$container" --network "$network" -p 127.0.0.1::8080 \
  -e ORG_ID=smoke-tenant \
  -e PUBLIC_WEB_URL=https://tenant.example.com \
  -e PORTAL_PUBLIC_URL=https://tenant.example.com \
  -e "DATABASE_URL=postgres://qm:qm@$postgres:5432/qm" \
  -e SESSION_STORE=postgres \
  -e RUN_STORE=postgres \
  -e HARNESS=mock \
  -e SANDBOX_BACKEND=local \
  -e ADMIN_GRANTS=admin@example.com:org_admin \
  -e CORE_SIGNING_SECRET="$(openssl rand -hex 32)" \
  -e CAPABILITY_SECRET="$(openssl rand -hex 32)" \
  -e PORTAL_IDENTITY_SECRET="$(openssl rand -hex 32)" \
  -e CONNECTOR_SECRET_KEY="$(openssl rand -hex 32)" \
  -e SKILL_SIGNING_SECRET="$(openssl rand -hex 32)" \
  -e PORTAL_SESSION_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_SIGNING_JWK="$signing_jwk" \
  -e AUTH_TOKEN_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_CLIENT_SECRET="$(openssl rand -hex 32)" \
  -e AUTH_ALLOWED_EMAIL_DOMAIN=example.com \
  -e "AUTH_EMAIL_FROM=QM <no-reply@example.com>" \
  -e AUTH_EMAIL_TRANSPORT=resend \
  -e RESEND_API_KEY=re_runtime_smoke \
  "$image" > /dev/null

port="$(docker port "$container" 8080/tcp | head -1 | sed 's/.*://')"

for _ in {1..120}; do
  if curl -fs "http://127.0.0.1:$port/healthz" > /dev/null; then
    docker exec "$container" node -e "fetch('http://127.0.0.1:8081/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    docker exec "$container" node -e "fetch('http://127.0.0.1:8082/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    docker exec "$container" node -e "fetch('http://127.0.0.1:8082/admin/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    docker exec "$container" node -e "fetch('http://127.0.0.1:8099/.well-known/jwks.json').then(async r=>{const j=await r.json();process.exit(r.ok&&j.keys?.length===1?0:1)}).catch(()=>process.exit(1))"
    echo "ok: tenant image serves portal on the container port with core, web-ui, the admin module and the embedded broker healthy on loopback"
    exit 0
  fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$container")" == true ]] || break
  sleep 2
done

docker logs "$container" >&2 || true
echo "tenant image failed to serve /healthz" >&2
exit 1
