# opencode-gate 镜像构建与推送

基于 [qq4756283/Actions-buildUtils](https://github.com/qq4756283/Actions-buildUtils)
的 Docker Hub 自动构建方案，覆盖本仓库 `gate.ts` 网关。

## 两个入口

| 工作流 | 触发方式 | 用途 |
|---|---|---|
| `.github/workflows/build-push.yml` | push `main` / push `v*` tag / 手动 | 本仓库日常构建，push 即出镜像 |
| `.github/workflows/docker-hub.yml` | `workflow_dispatch` / `repository_dispatch` | Actions-buildUtils 兼容入口，可代构建任意仓库 |

两条路都用 Actions-buildUtils 的输入契约（`repoUrl` / `repoBranch` / `imageName` /
`dockerFileUrl` / `platforms` / `tags` / `timeTagsFormat` / `timeTagsPrefix`），
所以同一套 Actions-buildUtils 实例既能构建本仓库，也能构建外部仓库。

## 必需 Secrets

仓库 `Settings → Secrets and variables → Actions`：

| 名称 | 说明 |
|---|---|
| `DOCKER_HUB_USERNAME` | Docker Hub 用户名 |
| `DOCKER_HUB_ACCESS_TOKEN` | Docker Hub Access Token（read/write 权限） |

`qq4756283/Actions-buildUtils` 里这两个 secret 已经存在，本仓库需要另外添加。

## 用法一：手动触发 Actions-buildUtils

```powershell
# 默认：构建本仓库 main，latest + 时间 tag
pwsh -File scripts/trigger-build.ps1

# 代构建上游仓库（必须带 dockerFileUrl，见下方"为什么需要自定义 Dockerfile"）
pwsh -File scripts/trigger-build.ps1 `
  -RepoUrl https://github.com/spfnas/opencode2api-free.git `
  -DockerFileUrl https://raw.githubusercontent.com/qq4756283/opencode2api-free/main/Dockerfile

# 只验证构建不推送
pwsh -File scripts/trigger-build.ps1 -NoTimeTag
```

脚本从 `git credential fill` 读已登录的 GitHub token，也可直接给 `$env:GITHUB_TOKEN`。

## 用法二：API 触发 repository_dispatch

```powershell
$h = @{ Authorization = "Bearer $env:GITHUB_TOKEN"; Accept = 'application/vnd.github+json' }
$body = @{
  event_type = 'build-docker'
  client_payload = @{
    repoUrl        = 'https://github.com/qq4756283/opencode2api-free.git'
    repoBranch     = 'main'
    imageName      = 'opencode-gate'
    dockerFileUrl  = 'https://raw.githubusercontent.com/qq4756283/opencode2api-free/main/Dockerfile'
    platforms      = 'linux/amd64,linux/arm64'
    tags           = 'latest'
    timeTagsFormat = '年-月-日_时-分-秒'
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' `
  -Body $body -Uri 'https://api.github.com/repos/qq4756283/Actions-buildUtils/dispatches'
```

## 为什么必须传自定义 Dockerfile

上游 `spfnas/opencode2api-free` 的 Dockerfile 是：

```dockerfile
FROM opencode-gate:latest
COPY gate.ts /app/gate.ts
COPY public/ /app/public/
CMD ["npx", "tsx", "gate.ts"]
```

`opencode-gate:latest` 是作者本机手工 build 出来的本地镜像，**从来没推过 Docker Hub**，
CI runner 上 `docker pull opencode-gate:latest` 必然 404 → 构建直接失败。

本仓库的 Dockerfile 改成自包含：多阶段、`node:22-alpine`、`npm ci` 装依赖、
tsx 直接跑 TypeScript，不依赖任何预构建基础镜像。

## 修掉的一个崩溃 bug

上游 `gate.ts` 把 `/ping` 注册在**两个** request 监听器里：

```ts
const server = http.createServer(handler);          // 监听器 1
server.on('request', (req, res) => {                 // 监听器 2
  if (req.url === '/ping') { res.writeHead(200); res.end('pong'); return; }
});
```

两个监听器都会执行。请求 `/ping` 时监听器 1 走完 handler → 落到 404 分支写完响应，
监听器 2 再 `writeHead(200)` → `ERR_HTTP_HEADERS_SENT` → **Node 进程直接崩**。

也就是说原版只要被访问一次 `/ping`（包括 Docker HEALTHCHECK 和编排探针）就整个挂掉。

修法：把 `/ping` 移进 handler 内部最前面，删掉第二个监听器。

```
ERR http://.../ping : (404)
Error [ERR_HTTP_HEADERS_SENT]: Cannot write headers after they are sent to the client
    at ServerResponse.writeHead (node:_http_server:411:11)
    at Server.<anonymous> (gate.ts:1314:34)     ← 第二个监听器
```

修复后本地连打 20 次 `/ping` 全部 `pong`，进程存活。

## 镜像内容

- 基础：`node:22-alpine`（`linux/amd64` + `linux/arm64`）
- 运行时：`npx tsx gate.ts`，无编译步骤
- 依赖：`npm ci --omit=dev`（`hpagent`、`socks-proxy-agent`）
- 非 root：`USER node`
- 健康检查：`wget -qO- http://127.0.0.1:13339/ping | grep -q pong`
- 默认环境：`PORT=13339`、`DATA_DIR=/app/data`、`SINGBOX_MODE=off`、`API_KEY=admin123`

`NPM_REGISTRY` 是 build arg，默认走 npmmirror。换官方源：

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org -t opencode-gate .
```

## 运行

```bash
# 拉镜像跑
docker compose up -d
GATE_IMAGE=<你的namespace>/opencode-gate:latest docker compose up -d

# 本地构建
docker compose -f docker-compose.build.yml up -d --build

# 裸 docker run
docker run -d --name opencode-gate \
  -p 13339:13339 \
  -v ./data:/app/data \
  -e API_KEY=admin123 \
  opencode-gate:latest
```

管理面板 <http://localhost:13339/>，`curl localhost:13339/status` 看状态。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `13339` | HTTP 端口 |
| `API_KEY` | `admin123` | 管理 API key，**部署后务必改** |
| `DATA_DIR` | `/app/data` | 持久化目录（keys.json / audit.jsonl 等） |
| `SINGBOX_MODE` | `off` | `on` 时走 sing-box 订阅节点 |
| `SINGBOX_HOST` | `127.0.0.1` | sing-box 地址 |
| `SINGBOX_HTTP_PORT` | `10800` | sing-box HTTP 入口 |
| `SINGBOX_SOCKS_PORT` | `10801` | sing-box SOCKS5 入口 |
| `SINGBOX_API_PORT` | `9090` | sing-box clash_api |

注意 `gate.ts`（SingBox 版）和 `gate-docker.ts`（Per-Key IP Pool 版）是两个不同入口，
镜像默认跑 `gate.ts`。切到另一个：

```bash
docker run -d opencode-gate:latest npx tsx gate-docker.ts
```
