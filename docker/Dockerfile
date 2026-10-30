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
# worker deploy bundle (same layout as the Windows package: data/worker-dist)
COPY data/worker-dist ./data/worker-dist
ENV NODE_ENV=production PORT=3300 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3300
CMD ["node", "server/src/index.js"]
