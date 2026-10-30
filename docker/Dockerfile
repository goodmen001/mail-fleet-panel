FROM node:22-alpine AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY --from=build /app/web/dist ./web/dist
# worker deploy bundles (builtin/ is NOT under the data volume mount, so a
# ./data:/app/data mount can no longer hide them — was data/worker-dist)
COPY data/worker-dist ./builtin/worker-dist
COPY data/official-dist ./builtin/official-dist
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=3300 DATA_DIR=/app/data APP_VERSION=${APP_VERSION}
# keep the in-image fallback (server/package.json) in sync: CI docker job checks
# out fresh code where it still reads 1.0.0 — the version chain then lies. Also
# guards local `docker compose build` (compose passes the arg, but a bare
# `docker build` without --build-arg lands on the "dev" default instead of 1.0.0).
RUN node -e "const fs=require('fs');const p='./server/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=process.env.APP_VERSION;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
VOLUME /app/data
EXPOSE 3300
CMD ["node", "server/src/index.js"]
