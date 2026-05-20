# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base
WORKDIR /app
RUN corepack enable && apk add --no-cache git openssh-client tini \
    && apk add --no-cache --virtual .build-deps python3 make g++
COPY package.json pnpm-lock.yaml ./

FROM base AS deps
RUN pnpm install --frozen-lockfile
RUN apk del .build-deps

FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=development
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["pnpm", "dev"]

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine AS prod
WORKDIR /app
RUN apk add --no-cache git openssh-client tini
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/prompts ./dist/src/prompts
COPY --from=build --chown=node:node /app/package.json ./
COPY --chown=node:node docker/entrypoint.sh /app/docker/entrypoint.sh
RUN chmod +x /app/docker/entrypoint.sh
USER node
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
