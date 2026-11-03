FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts/build.mjs ./scripts/build.mjs
COPY src ./src
RUN npm run bundle

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build --chown=node:node /build/dist/gitferry-mcp.cjs /app/gitferry-mcp.cjs
USER node
ENTRYPOINT ["node", "/app/gitferry-mcp.cjs"]
