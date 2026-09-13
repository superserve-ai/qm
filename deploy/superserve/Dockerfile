
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS web-build
WORKDIR /app/plugins/web-ui
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/chassis/src /app/plugins/chassis/src
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/public ./public
COPY plugins/web-ui/src ./src
RUN npm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd
RUN apk add --no-cache ca-certificates curl git git-daemon util-linux
WORKDIR /app

COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
RUN npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache

COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./plugins/web-ui/
RUN cd plugins/web-ui && npm ci --omit=dev && rm package-lock.json && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/portal/package.json plugins/portal/package-lock.json ./plugins/portal/
RUN cd plugins/portal && npm ci --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache \
  && mkdir -p /app/plugins/auth && ln -s /app/plugins/portal/node_modules /app/plugins/auth/node_modules

COPY src ./src
COPY tsconfig.json ./
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis

COPY plugins/admin/src ./plugins/admin/src
COPY plugins/admin/public ./plugins/admin/public
COPY plugins/admin/tsconfig.json ./plugins/admin/
COPY plugins/auth/src ./plugins/auth/src
COPY plugins/auth/tsconfig.json ./plugins/auth/
COPY plugins/portal/src ./plugins/portal/src
COPY plugins/portal/tsconfig.json ./plugins/portal/
COPY plugins/web-ui/server ./plugins/web-ui/server
COPY --from=web-build /app/plugins/web-ui/dist-web ./plugins/web-ui/dist-web

COPY scripts/qm-tenant-entry.mjs scripts/qm-tenant-loopback.mjs ./scripts/

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV SHUTDOWN_DRAIN_MS=1000
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
USER node
ENTRYPOINT ["node", "scripts/qm-tenant-entry.mjs"]
