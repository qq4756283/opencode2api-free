#!/bin/sh
# ─────────────────────────────────────────────────────────────
#  opencode-gate entrypoint
#
#  为什么要这个脚本：
#
#  镜像里 USER node（uid 1000）跑进程，这是对的安全默认值。
#  但只要挂了宿主目录进来（-v /opt/opencode-gate/data:/app/data），
#  目录属主通常是 root —— 容器内 uid 1000 就写不进去：
#
#    ❌ [Key] 保存失败: EACCES: permission denied, open '/app/data/keys.json'
#
#  表现是面板上改配置「显示成功」但一刷新就回去，因为根本没落盘。
#
#  做法：容器以 root 启动 → 把挂载目录属主修成 node → 再降权执行。
#  运行时仍然是非 root，只是不需要用户手工 chown。
# ─────────────────────────────────────────────────────────────
set -e

# 需要修属主的目录：数据目录 + singbox 配置目录 + public（可能被只读挂载）
for d in "${DATA_DIR:-/app/data}" /app/data /app/singbox /app/public; do
  [ -n "$d" ] || continue
  [ -d "$d" ] || mkdir -p "$d" 2>/dev/null || continue
  # 只在属主不对时才动手，避免无谓的递归 chown 拖慢启动
  if [ "$(stat -c '%u:%g' "$d" 2>/dev/null)" != "1000:1000" ]; then
    echo "[entrypoint] 修正目录属主: $d ($(stat -c '%u:%g' "$d" 2>/dev/null) -> 1000:1000)"
    chown -R 1000:1000 "$d" 2>/dev/null || \
      echo "[entrypoint] 警告: $d 属主修正失败，若日志报 EACCES 请手工 chown -R 1000:1000"
  fi
done

if [ "$(id -u)" = "0" ]; then
  # su-exec 来自 alpine 的 su-exec 包，比 su/sudo 轻，Dockerfile 里已装
  if command -v su-exec >/dev/null 2>&1; then
    exec su-exec node "$@"
  fi
  echo "[entrypoint] 警告: 找不到 su-exec，将以 root 执行（不推荐）"
fi

exec "$@"
