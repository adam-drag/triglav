FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./web
COPY tsconfig.json ./
# The dashboard builds its Codex launch command from the same file as the server and the runner.
COPY src/codex-args.ts ./src/codex-args.ts
RUN pnpm build:web

FROM node:24-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 7400
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:7400/api/health || exit 1
CMD ["node", "src/main.ts"]
