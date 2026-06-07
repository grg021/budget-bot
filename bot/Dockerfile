FROM node:22-bookworm-slim
# build tools: fallback for native deps (better-sqlite3) if no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
# ci installs exactly from the committed lockfile (reproducible, no surprise upgrades)
RUN npm ci --omit=dev
COPY src ./src
COPY migrate ./migrate
ENV NODE_ENV=production
# Run unprivileged. The node:22 image ships a non-root `node` user (uid 1000);
# pre-create /data so a fresh bot-data volume inherits node ownership. /app stays
# root-owned (read-only to node) so a compromised process can't rewrite the source.
RUN mkdir -p /data && chown -R node:node /data
USER node
CMD ["node", "src/index.js"]
