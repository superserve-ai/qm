# Single-container tenant image: core + web-ui (with admin) + portal (with the embedded
# sign-in broker), supervised by scripts/qm-tenant-entry.mjs. Only portal's port is exposed.
# Build from the repository root:  docker build -f deploy/superserve/Dockerfile .

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS web-build
WORKDIR /app/plugins/web-ui
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/chassis/src /app/plugins/chassis/src
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/src ./src
RUN npm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN apk add --no-cache ca-certificates curl git git-daemon util-linux
WORKDIR /app

# Core runtime dependencies (same install as deploy/core/Dockerfile).
COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

# Plugin runtime dependencies. Auth shares portal's node_modules, as deploy/portal/Dockerfile does.
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./plugins/web-ui/
RUN cd plugins/web-ui && npm ci --omit=dev && rm package-lock.json && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/portal/package.json plugins/portal/package-lock.json ./plugins/portal/
RUN cd plugins/portal && npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache \
  && mkdir -p /app/plugins/auth && ln -s /app/plugins/portal/node_modules /app/plugins/auth/node_modules

# Core.
COPY src ./src
COPY tsconfig.json ./
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis

# Surfaces: web-ui (serves admin under /admin), portal (embeds auth).
COPY plugins/admin/src ./plugins/admin/src
COPY plugins/admin/public ./plugins/admin/public
COPY plugins/admin/tsconfig.json ./plugins/admin/
COPY plugins/auth/src ./plugins/auth/src
COPY plugins/auth/tsconfig.json ./plugins/auth/
COPY plugins/portal/src ./plugins/portal/src
COPY plugins/portal/tsconfig.json ./plugins/portal/
COPY plugins/web-ui/server ./plugins/web-ui/server
COPY --from=web-build /app/plugins/web-ui/dist-web ./plugins/web-ui/dist-web

# Supervisor.
COPY scripts/qm-tenant-entry.mjs scripts/qm-tenant-loopback.mjs ./scripts/

ENV NODE_ENV=production
ENV DATA_DIR=/data
# Cloud Run's default termination grace is 10s; core drains for SHUTDOWN_DRAIN_MS plus a 5s
# backstop, so keep this at least 6s under the configured grace period.
ENV SHUTDOWN_DRAIN_MS=4000
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
USER node
ENTRYPOINT ["node", "scripts/qm-tenant-entry.mjs"]
