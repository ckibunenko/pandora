FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM build AS api
WORKDIR /app/apps/api
ENV NODE_ENV=production
USER node
CMD ["node", "dist/main.js"]

FROM nginx:stable-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94 AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/demo/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/demo/maintenance.html /usr/share/nginx/html/maintenance.html
