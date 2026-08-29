# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY backend ./backend
COPY extension ./extension
COPY scripts ./scripts

RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3030

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist/backend ./dist/backend
RUN mkdir -p /home/node/.node-llama-cpp/models \
    && chown -R node:node /home/node/.node-llama-cpp

USER node

VOLUME ["/home/node/.node-llama-cpp/models"]
EXPOSE 3030

HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3030') + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "dist/backend/server.js"]
