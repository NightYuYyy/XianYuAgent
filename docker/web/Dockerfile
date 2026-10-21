FROM node:24-bookworm-slim AS build
WORKDIR /workspace
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json .npmrc ./
COPY scripts ./scripts
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY apps/web ./apps/web
RUN npm run build:web

FROM nginx:alpine
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
