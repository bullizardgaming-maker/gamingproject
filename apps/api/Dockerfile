# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci --workspace apps/api --include-workspace-root=false
COPY apps/api apps/api
# npm keeps a few packages under apps/api/node_modules (versions that differ from the hoisted ones, e.g.
# @sentry/node, undici); both folders go into the image. mkdir: the COPY below needs it to exist.
RUN npm run build -w apps/api && npm prune --omit=dev --workspace apps/api && mkdir -p apps/api/node_modules

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/migrations apps/api/migrations
COPY --from=build /app/apps/api/package.json apps/api/
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
