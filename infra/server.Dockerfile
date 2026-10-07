# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /atlas
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/view-runtime/package.json packages/view-runtime/package.json
RUN npm ci --ignore-scripts
COPY packages/protocol/src packages/protocol/src
COPY packages/protocol/tsconfig.json packages/protocol/tsconfig.json
COPY packages/view-runtime/src packages/view-runtime/src
COPY packages/view-runtime/tsconfig.json packages/view-runtime/tsconfig.json
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/tsconfig.json
RUN npm run build:server

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /atlas
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/node/package.json apps/node/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/view-runtime/package.json packages/view-runtime/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @atlas/server --workspace @atlas/protocol --workspace @atlas/view-runtime --include-workspace-root=false
COPY --from=build /atlas/apps/server/dist apps/server/dist
COPY --from=build /atlas/packages/protocol/dist packages/protocol/dist
COPY --from=build /atlas/packages/view-runtime/dist packages/view-runtime/dist
COPY apps/server/migrations apps/server/migrations
USER node
WORKDIR /atlas/apps/server
CMD ["node", "dist/server.js"]
