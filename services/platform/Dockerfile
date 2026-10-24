FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY services/platform/package.json services/platform/
RUN npm ci --workspace @openparty/platform --include-workspace-root
# The three layers are data, not code: floor, law packs, party settings and the public registry.
COPY floor floor
COPY packs packs
COPY parties parties
COPY registry registry
COPY services/platform services/platform
# The anonymous membership proof needs its proving files (about 6 MB). They are downloaded here and CHECKED against pinned SHA-256 hashes: a
# changed file fails the build. The platform then serves them to voters' browsers itself.
COPY scripts/fetch-semaphore-artifacts.mjs scripts/fetch-semaphore-artifacts.mjs
RUN node scripts/fetch-semaphore-artifacts.mjs 20
ENV OPENPARTY_ROOT=/app
WORKDIR /app/services/platform
USER node
CMD ["npx", "tsx", "src/main.ts"]
