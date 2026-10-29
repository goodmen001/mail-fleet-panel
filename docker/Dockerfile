FROM node:20-alpine AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY --from=build /app/web/dist ./web/dist
ENV NODE_ENV=production PORT=3300 DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3300
CMD ["node", "server/src/index.js"]
