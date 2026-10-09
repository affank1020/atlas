FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
WORKDIR /atlas

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/view-runtime/package.json packages/view-runtime/package.json
RUN npm ci --ignore-scripts

COPY packages/view-runtime/src packages/view-runtime/src
COPY packages/view-runtime/tsconfig.json packages/view-runtime/tsconfig.json
COPY apps/web apps/web
RUN npm run build:web

FROM public.ecr.aws/docker/library/caddy:2-alpine
COPY infra/Caddyfile.production /etc/caddy/Caddyfile
COPY --from=build /atlas/apps/web/dist /srv
