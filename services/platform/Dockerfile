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
ENV OPENPARTY_ROOT=/app
WORKDIR /app/services/platform
USER node
CMD ["npx", "tsx", "src/main.ts"]
