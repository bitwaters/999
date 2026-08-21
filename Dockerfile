FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json eslint.config.mjs .prettierrc.json ./
COPY config ./config
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM build AS test
CMD ["npm", "test"]

FROM build AS production-deps
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=production-deps /app/dist ./dist
COPY --from=production-deps /app/config ./config
COPY --from=production-deps /app/scripts/replay-report.mjs ./scripts/replay-report.mjs
COPY --from=production-deps /app/scripts/continuous-sampler.mjs ./scripts/continuous-sampler.mjs
COPY --from=production-deps /app/scripts/redact.mjs ./scripts/redact.mjs
VOLUME ["/app/data"]
CMD ["node", "dist/app/healthcheck.js"]
