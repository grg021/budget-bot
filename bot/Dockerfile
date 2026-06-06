FROM node:22-bookworm-slim
# build tools: fallback for native deps (better-sqlite3) if no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY migrate ./migrate
ENV NODE_ENV=production
CMD ["node", "src/index.js"]
