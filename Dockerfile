# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────
#  opencode-gate — standalone image
#  入口 gate.ts 用 tsx 直接跑 TypeScript，不做编译步骤
#  上游原 Dockerfile 是 `FROM opencode-gate:latest`，
#  依赖本机手工构建的本地基础镜像 → CI 里必然 pull 失败，这里改成自包含。
# ─────────────────────────────────────────────────────────────
ARG NODE_IMAGE=node:22-alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ── deps: 只装生产依赖 ──────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY
WORKDIR /app
# npm 官方源在 CI 上偶发慢，给可覆盖的 registry；换回官方源：--build-arg NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry "${NPM_REGISTRY}"
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ── runtime ────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG NPM_REGISTRY
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    NPM_REGISTRY=${NPM_REGISTRY} \
    PORT=13339 \
    DATA_DIR=/app/data \
    SINGBOX_MODE=off \
    MAX_BODY=33554432 \
    AUDIT_MAX_BYTES=67108864 \
    AUDIT_KEEP=5 \
    MAX_CONNECTIONS=2048
# ADMIN_TOKEN 不给默认值。配了它，/api/* 才要鉴权；
# 不配 = 管理接口敞开（能列明文 key、建/删 key、改订阅）。
# 公网部署必须显式设置，且不要写进镜像 —— 用 docker run -e 或 compose 的 .env。
#
# API_KEY 也不设默认：它不是鉴权凭据（见 README），调用用的 key 存在
# data/keys.json，首次启动自动生成 sk-default。留这个变量纯粹为兼容旧配置。
WORKDIR /app

# tsx 作为 devDep 单独装到 runtime；node:22-alpine 自带 wget（busybox），HEALTHCHECK 直接用它
RUN npm config set registry "${NPM_REGISTRY}" \
 && npm install -g tsx --no-audit --no-fund \
 && mkdir -p /app/data /app/public \
 && chown -R node:node /app
USER node

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node gate.ts ./gate.ts
COPY --chown=node:node gate-docker.ts ./gate-docker.ts
COPY --chown=node:node public/ ./public/

EXPOSE 13339

# /ping 由 gate.ts 的 handler 内部处理（见 Dockerfile 上方注释说明的历史崩溃 bug）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/ping" | grep -q pong || exit 1

CMD ["npx", "tsx", "gate.ts"]
