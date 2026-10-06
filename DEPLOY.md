opencode-gate 远程服务器部署教程

镜像已经在 Docker Hub 上，双架构（amd64 + arm64），拉取即用，不需要编译。

  镜像      qq4756283/opencode-gate:latest
  大小      69.5 MB
  digest    sha256:c93ffaf3218b5bc93179ced74bb1ecda8ef31929d7aae63efc32817a35eae5f7
  端口      13339


─────────────────────────────────────────────────────────────
一、最快路径：一条 docker run
─────────────────────────────────────────────────────────────

适合先跑起来看看能不能用。

  docker run -d \
    --name opencode-gate \
    --restart always \
    -p 13339:13339 \
    -v /opt/opencode-gate/data:/app/data \
    -e API_KEY=sk-default \
    qq4756283/opencode-gate:latest

验证：

  docker ps                                   # STATUS 应为 healthy
  curl http://127.0.0.1:13339/ping           # pong
  curl http://127.0.0.1:13339/status         # JSON 状态
  curl http://127.0.0.1:13339/v1/models \
    -H 'Authorization: Bearer sk-default'     # 模型列表

管理面板在 http://<服务器IP>:13339/ ，用浏览器打开。


─────────────────────────────────────────────────────────────
二、正式部署：docker compose
─────────────────────────────────────────────────────────────

### 1. 建目录

  mkdir -p /opt/opencode-gate/data
  cd /opt/opencode-gate

### 2. 写 .env

  cat > /opt/opencode-gate/.env <<'EOF'
  GATE_IMAGE=qq4756283/opencode-gate:latest
  API_KEY=sk-default
  TZ=Asia/Shanghai
  EOF

API_KEY 这行是客户端调用时要带的 key。默认值是 sk-default，
生产环境建议改掉，改完重启容器生效。

### 3. 写 docker-compose.yml

  cat > /opt/opencode-gate/docker-compose.yml <<'EOF'
  services:
    opencode-gate:
      image: ${GATE_IMAGE:-qq4756283/opencode-gate:latest}
      container_name: opencode-gate
      restart: always
      ports:
        - "13339:13339"
      volumes:
        - ./data:/app/data
      environment:
        - TZ=Asia/Shanghai
        - PORT=13339
        - API_KEY=${API_KEY:-sk-default}
        - DATA_DIR=/app/data
        - SINGBOX_MODE=off
      healthcheck:
        test: ["CMD", "wget", "-qO-", "http://127.0.0.1:13339/ping"]
        interval: 30s
        timeout: 5s
        retries: 3
        start_period: 20s
      logging:
        driver: json-file
        options:
          max-size: "10m"
          max-file: "3"
  EOF

注意这里没有挂 ./public。管理面板已经打进镜像了，挂载反而会因为
宿主机目录是空的而把面板弄没。

### 4. 启动

  docker compose up -d
  docker compose ps
  docker compose logs -f --tail 50

看到 healthy 就成了。


─────────────────────────────────────────────────────────────
三、防火墙 / 端口放行
─────────────────────────────────────────────────────────────

容器监听 13339，但外部能不能连上看防火墙。

CentOS / RHEL / Rocky：

  firewall-cmd --permanent --add-port=13339/tcp
  firewall-cmd --reload

Ubuntu / Debian（ufw）：

  ufw allow 13339/tcp

云服务器还要在控制台安全组里放行 13339 入方向。

只在服务器本机用的话，可以不映射端口，改成：

  ports:
    - "127.0.0.1:13339:13339"

然后用 SSH 端口转发访问：

  ssh -L 13339:127.0.0.1:13339 root@服务器IP


─────────────────────────────────────────────────────────────
四、客户端怎么调
─────────────────────────────────────────────────────────────

这是 OpenAI 兼容接口，base_url 指到这台服务器，key 用上面的 API_KEY。

### curl

  curl http://服务器IP:13339/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer sk-default' \
    -d '{
      "model": "gpt-5",
      "messages": [{"role": "user", "content": "你好"}],
      "stream": false
    }'

### Python（openai SDK）

  from openai import OpenAI

  client = OpenAI(
      base_url="http://服务器IP:13339/v1",
      api_key="sk-default",
  )

  resp = client.chat.completions.create(
      model="gpt-5",
      messages=[{"role": "user", "content": "你好"}],
  )
  print(resp.choices[0].message.content)

### Node.js

  import OpenAI from "openai";

  const client = new OpenAI({
    baseURL: "http://服务器IP:13339/v1",
    apiKey: "sk-default",
  });

  const resp = await client.chat.completions.create({
    model: "gpt-5",
    messages: [{ role: "user", content: "你好" }],
  });

### 流式

  curl -N http://服务器IP:13339/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer sk-default' \
    -d '{"model":"gpt-5","messages":[{"role":"user","content":"你好"}],"stream":true}'

### 模型名的坑

网关会把 body 里的 model 自动补 `-free` 后缀，发给上游的是
`<你的模型名>-free`。所以写 `gpt-5` 实际打的是 `gpt-5-free`。

先查一下当前能用哪些：

  curl http://服务器IP:13339/v1/models -H 'Authorization: Bearer sk-default'

返回的 `/v1/models` 已经被网关过滤过，只保留 `-free` 后缀的模型
和一个 `big-pickle`。

### OpenCode 客户端配置

  # ~/.config/opencode/opencode.json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "mygate": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "opencode-gate",
        "options": { "baseURL": "http://服务器IP:13339/v1" },
        "models": {
          "gpt-5-free": { "name": "GPT-5 (gate)" }
        }
      }
    },
    "model": "mygate/gpt-5-free"
  }


─────────────────────────────────────────────────────────────
五、Key 管理
─────────────────────────────────────────────────────────────

首次启动会在 /opt/opencode-gate/data/keys.json 建一个默认 key
`sk-default`。之后可以用管理 API 加自己的 key。

列出现有 key：

  curl http://127.0.0.1:13339/api/keys

新建一个（自动生成 key 值）：

  curl -X POST http://127.0.0.1:13339/api/keys \
    -H 'Content-Type: application/json' \
    -d '{"name":"my-app","maxConcurrency":5,"maxRequests":1000000}'

指定 key 值新建：

  curl -X POST http://127.0.0.1:13339/api/keys \
    -H 'Content-Type: application/json' \
    -d '{"key":"sk-mycustomkey","name":"my-app"}'

删掉：

  curl -X DELETE http://127.0.0.1:13339/api/keys/sk-mycustomkey

改并发上限 / 过期时间：

  curl -X PUT http://127.0.0.1:13339/api/keys/sk-mycustomkey \
    -H 'Content-Type: application/json' \
    -d '{"maxConcurrency":10}'

限流规则：单 key 默认并发 5、请求数上限 100 万、有效期 1 年
（`expiresAt: 0` 表示永不过期，`maxRequests: 0` 表示不限次）。


─────────────────────────────────────────────────────────────
六、安全提醒
─────────────────────────────────────────────────────────────

**先说清楚这个镜像的现状**（读源码得到的，不是猜的）：

1. `/api/*` 管理接口**没有鉴权**。源码里 `API_KEY` 这个环境变量只被
   `console.log` 打印了一次，从来没参与任何鉴权判断。能改 key、看审计
   日志、切配置的接口全都裸着。所以：

   - 绝对不要把 13339 直接暴露到公网
   - 必须公网暴露的话，前面套一层 Nginx / Caddy 加 Basic Auth 或 IP 白名单

2. `/v1/*` 有 key 校验（`validateKey`），但 `/api/*` 没有。

推荐的加固方式 —— Nginx 反代 + Basic Auth：

  # /etc/nginx/conf.d/opencode-gate.conf
  server {
      listen 80;
      server_name gate.example.com;

      location / {
          auth_basic "opencode-gate";
          auth_basic_user_file /etc/nginx/.htpasswd;

          proxy_pass http://127.0.0.1:13339;
          proxy_http_version 1.1;

          # SSE 流式必须关缓冲，否则请求会卡住
          proxy_buffering off;
          proxy_cache off;
          proxy_read_timeout 600s;
          proxy_send_timeout 600s;

          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header Connection '';
      }
  }

  htpasswd -Bc /etc/nginx/.htpasswd admin
  nginx -t && systemctl reload nginx

生成密码：

  apt install -y apache2-utils      # 或 yum install -y httpd-tools
  htpasswd -Bc /etc/nginx/.htpasswd admin

配了反代之后 compose 里的端口改成只听本机：

  ports:
    - "127.0.0.1:13339:13339"


─────────────────────────────────────────────────────────────
七、日常运维
─────────────────────────────────────────────────────────────

### 看状态

  docker ps                                    # 健康状态
  docker inspect --format='{{.State.Health.Status}}' opencode-gate
  curl http://127.0.0.1:13339/ping
  curl http://127.0.0.1:13339/status | jq .
  curl http://127.0.0.1:13339/api/logs | jq .

### 升级

  cd /opt/opencode-gate
  docker compose pull
  docker compose up -d
  docker image prune -f

data 目录是 volume 挂载的，升级不影响 keys.json 和审计日志。

### 回滚

  docker compose down
  # 上一版镜像
  docker run -d --name opencode-gate --restart always \
    -p 13339:13339 \
    -v /opt/opencode-gate/data:/app/data \
    -e API_KEY=sk-default \
    qq4756283/opencode-gate@sha256:<旧 digest>

### 日志

  docker logs -f --tail 100 opencode-gate
  docker logs --since 1h opencode-gate

容器内没装 logrotate，用 compose 里的 logging options 限制大小
（配置里已经写了 max-size 10m × 3）。

### 备份

data 目录里就那几个文件，直接打包：

  cd /opt/opencode-gate
  tar czf backup-$(date +%F).tar.gz data/

里面是 keys.json、audit.jsonl、models_cache.json、subscription.json。
keys.json 存的是明文 key，备份文件注意权限（chmod 600）。


─────────────────────────────────────────────────────────────
八、排查
─────────────────────────────────────────────────────────────

### 容器起不来 / 反复重启

  docker logs --tail 100 opencode-gate

### healthy 但请求 502 / 超时

先直连容器确认服务本身是好的：

  docker exec opencode-gate wget -qO- http://127.0.0.1:13339/ping

通了说明是反向代理的问题，重点查 `proxy_buffering off` 有没有配。

### 流式请求卡住不出字

Nginx 缓冲没关。必须：

  proxy_buffering off;
  proxy_read_timeout 600s;

### 401

key 不在 keys.json 里，或者被禁用 / 过期 / 超并发超次数。
先查：

  curl http://127.0.0.1:13339/api/keys

注意 key 是区分大小写的精确匹配。

### /v1/models 返回空

上游 opencode.ai/zen 拉不到，或者网络不通。容器里测：

  docker exec opencode-gate wget -qO- --timeout=10 https://opencode.ai/zen/v1/models | head -c 300

国内服务器访问 opencode.ai 大概率不通，需要配 SINGBOX_MODE=on
（见下一节）或者在服务器上先解决出网。

### 模型列表缓存

网关会缓存上游模型列表 5 分钟。手动刷：

  curl -X POST http://127.0.0.1:13339/api/models/refresh


─────────────────────────────────────────────────────────────
九、SINGBOX 模式（可选）
─────────────────────────────────────────────────────────────

默认 `SINGBOX_MODE=off`，网关直连 opencode.ai/zen。
服务器在国内、出不去的话，需要挂 sing-box 提供 SOCKS5 出口。

当前镜像里的 sing-box 部分是「生成配置文件 + 通过 Docker socket 重启
另一个叫 `opengate-singbox` 的容器」这种用法，需要额外准备，比较绕。

实际部署更省事的做法是：让宿主机跑 sing-box，容器用 host 网络访问它。

compose 改成：

  services:
    opencode-gate:
      image: qq4756283/opencode-gate:latest
      container_name: opencode-gate
      restart: always
      network_mode: host          # 用宿主网络，直接访问 127.0.0.1:10801
      environment:
        - TZ=Asia/Shanghai
        - PORT=13339
        - API_KEY=${API_KEY:-sk-default}
        - DATA_DIR=/app/data
        - SINGBOX_MODE=on
        - SINGBOX_HOST=127.0.0.1
        - SINGBOX_HTTP_PORT=10800
        - SINGBOX_SOCKS_PORT=10801
        - SINGBOX_API_PORT=9090
      volumes:
        - ./data:/app/data

`network_mode: host` 意味着不能再写 `ports:`，端口直接由进程监听在
宿主 13339。同时容器里的 `/app/data` 权限要注意（host 网络下同样用
volume 挂载，路径没变）。

sing-box 自己怎么配是另一篇 topic，按你的订阅来。


─────────────────────────────────────────────────────────────
十、从源码构建（可选）
─────────────────────────────────────────────────────────────

服务器上没有预装 Docker 的话：

  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker

在本地构建并推：

  git clone https://github.com/qq4756283/opencode2api-free.git
  cd opencode2api-free
  docker build -t opencode-gate:local .

服务器上构建（国内拉 npm 慢，Dockerfile 默认走 npmmirror）：

  docker build -t opencode-gate:local .
  docker run -d --name opencode-gate -p 13339:13339 \
    -v /opt/opencode-gate/data:/app/data \
    opencode-gate:local

换官方 npm 源：

  docker build --build-arg NPM_REGISTRY=https://registry.npmjs.org \
    -t opencode-gate:local .


─────────────────────────────────────────────────────────────
十一、镜像里的东西
─────────────────────────────────────────────────────────────

  基础      node:22-alpine
  入口      npx tsx gate.ts（直接跑 TypeScript，无编译步骤）
  依赖      hpagent、socks-proxy-agent（npm ci --omit=dev）
  用户      非 root（USER node）
  健康检查  wget /ping | grep -q pong
  默认环境  PORT=13339  DATA_DIR=/app/data  SINGBOX_MODE=off  API_KEY=admin123

镜像里有两个入口，默认跑 `gate.ts`（SingBox 版）：

  gate.ts          SingBox 反代版，本次镜像用的
  gate-docker.ts   Per-Key IP Pool 版，代理池调度，另一套逻辑

要换：

  docker run ... qq4756283/opencode-gate:latest npx tsx gate-docker.ts

这两个版本的鉴权行为不一样（gate-docker.ts 有 401/403 校验），
如果你的场景需要代理池调度而不是订阅节点，切过去再测一遍鉴权。
