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
VOLUME /app/data
EXPOSE 3300
CMD ["node", "server/src/index.js"]
