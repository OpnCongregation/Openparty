FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/portal/package.json apps/portal/
RUN npm ci --workspace @openparty/portal --include-workspace-root
COPY apps/portal apps/portal
WORKDIR /app/apps/portal
ARG NEXT_PUBLIC_TRUSTLOG_URL=http://localhost:8080
ARG NEXT_PUBLIC_PLATFORM_URL=http://localhost:3000
ENV NEXT_PUBLIC_TRUSTLOG_URL=$NEXT_PUBLIC_TRUSTLOG_URL NEXT_PUBLIC_PLATFORM_URL=$NEXT_PUBLIC_PLATFORM_URL
RUN npx next build
USER node
CMD ["npx", "next", "start", "-p", "3001"]
