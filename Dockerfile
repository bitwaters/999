FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.mjs .prettierrc.json ./
COPY config ./config
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/scripts/replay-report.mjs ./scripts/replay-report.mjs
VOLUME ["/app/data"]
CMD ["node", "dist/app/healthcheck.js"]
