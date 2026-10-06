#!/usr/bin/env bun 

/**
 * opencode-free-gate — SingBox 反代网关
 * 去掉公共代理池，改用 sing-box 订阅节点 + 429 自动切换 + 直连兜底
 */

import https from 'node:https';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import { promises as dnsPromises } from 'node:dns';

// SSRF 校验用：DNS 解析失败时返回空结果而不是抛错
async function dnsLookupSafe(hostname: string): Promise<{ addresses: Array<{ address: string; family: number }> }> {
  try {
    return await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { addresses: [] };
  }
}

// ═══════════════════════════════════════════════════════════
//  类型定义
// ═══════════════════════════════════════════════════════════

interface ApiKeyRecord {
  key: string; name: string; enabled: boolean;
  createdAt: number; lastUsedAt: number;
  totalRequests: number; totalTokens: number;
  maxConcurrency: number; maxRequests: number;
  requestCount: number; expiresAt: number;
}

interface AuditEntry {
  ts: number; keyId: string; model: string;
  promptTokens: number; completionTokens: number; totalTokens: number;
  cacheCreation: number; cacheRead: number;
  latencyMs: number; status: number;
}

// ═══════════════════════════════════════════════════════════
//  持久化文件路径
// ═══════════════════════════════════════════════════════════

const DATA_DIR = process.env.DATA_DIR || process.cwd();
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const MODELS_CACHE_FILE = path.join(DATA_DIR, 'models_cache.json');
const SINGBOX_CONFIG_DIR = path.join(process.cwd(), 'singbox');
const SUBSCRIPTION_FILE = path.join(DATA_DIR, 'subscription.json');
const RUNTIME_CONFIG_FILE = path.join(DATA_DIR, 'runtime_config.json');

// 运行期可改的配置（面板 /api/config POST 落盘到这里）
let runtimeConfig: { proxyRefreshMs?: number } = {};
try {
  if (fs.existsSync(RUNTIME_CONFIG_FILE)) {
    runtimeConfig = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_FILE, 'utf-8')) || {};
  }
} catch {}

function saveRuntimeConfig() {
  try {
    fs.writeFileSync(RUNTIME_CONFIG_FILE, JSON.stringify(runtimeConfig, null, 2), 'utf-8');
  } catch {}
}

// ═══════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════

const UPSTREAM = 'https://opencode.ai/zen';
const PORT = parseInt(process.env.PORT || '13339');
const MAX_RETRIES = 3;
const TIMEOUT = 15000;
const STREAM_TIMEOUT = 300000;

// SingBox 配置
const SINGBOX_HOST = process.env.SINGBOX_HOST || '127.0.0.1';
const SINGBOX_HTTP_PORT = parseInt(process.env.SINGBOX_HTTP_PORT || '10800');
const SINGBOX_SOCKS_PORT = parseInt(process.env.SINGBOX_SOCKS_PORT || '10801');
const SINGBOX_API_PORT = parseInt(process.env.SINGBOX_API_PORT || '9090');
const SINGBOX_MODE = process.env.SINGBOX_MODE || 'on';

const SINGBOX_SOCKS_URL = `socks5h://${SINGBOX_HOST}:${SINGBOX_SOCKS_PORT}`;
const SINGBOX_API_URL = `http://${SINGBOX_HOST}:${SINGBOX_API_PORT}`;

const API_KEY = process.env.API_KEY || 'admin123';
const START_TIME = Date.now();

// ─────────────────────────────────────────────────────────────
//  管理接口鉴权（可选）
//
//  历史问题：/api/* 全线无鉴权，API_KEY 只被 console.log 打印过一次，
//  从未参与判断。公网部署时任何人都能列 key / 造 key / 删 key / 改订阅。
//
//  现在：设置 ADMIN_TOKEN 后，/api/*（除只读的 /api/status、/api/ping 外）
//  必须带对 token 才能访问。不设置则保持原有敞开行为，
//  以免破坏现有部署 —— 但公网部署强烈建议设置。
//
//  取 token 的三种方式，任一即可：
//   Authorization: Bearer <ADMIN_TOKEN>
//   X-Admin-Token: <ADMIN_TOKEN>
//   ?token=<ADMIN_TOKEN>
// ─────────────────────────────────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// 只读、且不含敏感信息的接口允许匿名访问（给面板首屏用）
const ADMIN_ANON_OK = new Set(['/api/status', '/api/ping', '/api/models']);

function extractAdminToken(req: http.IncomingMessage, parsed: URL): string {
  const h = String(req.headers['authorization'] || '');
  const bearer = h.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  const xt = String(req.headers['x-admin-token'] || '').trim();
  if (xt) return xt;
  return parsed.searchParams.get('token') || '';
}

function adminAuthorized(req: http.IncomingMessage, pathname: string, parsed: URL): boolean {
  // 没配 ADMIN_TOKEN → 不启用鉴权（保持向后兼容）
  if (!ADMIN_TOKEN) return true;
  if (ADMIN_ANON_OK.has(pathname)) return true;
  const provided = extractAdminToken(req, parsed);
  if (!provided) return false;
  // 定长比较，避免时序侧信道
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

// ═══════════════════════════════════════════════════════════
//  全局状态
// ═══════════════════════════════════════════════════════════

let apiKeys: Record<string, ApiKeyRecord> = {};
let activeRequests: Record<string, number> = {};
let cachedModels: any[] = [];
let cachedModelsTime = 0;
let stats = { total: 0, success: 0, rateLimited: 0, errors: 0 };
let singboxNodeIndex = 0;
let singboxNodes: string[] = [];
let singboxOk = false;

const recentLogs: string[] = [];
const MAX_LOGS = 500;
const auditLog: AuditEntry[] = [];
const MAX_AUDIT = 10000;

// ═══════════════════════════════════════════════════════════
//  日志捕获
// ═══════════════════════════════════════════════════════════

function logCapture(s: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${s}`;
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}
const _origLog = console.log;
console.log = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  logCapture(msg); _origLog.apply(console, args);
};
const _origError = console.error;
console.error = (...args: any[]) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  logCapture(`❌ ${msg}`); _origError.apply(console, args);
};

// ═══════════════════════════════════════════════════════════
//  上游 Header 白名单（兼容旧 opencode-gate 行为）
//  只转发这些 header，避免把客户端的 UA/accept-encoding 等脏数据传给上游
// ═══════════════════════════════════════════════════════════

const FORWARD = [
  'authorization', 'x-opencode-project', 'x-opencode-session',
  'x-opencode-request', 'x-opencode-client', 'content-type',
  'accept', 'anthropic-version', 'anthropic-beta',
];

function collectHeadersFromReq(nodeReq: http.IncomingMessage): Record<string, string> {
  const h: Record<string, string> = {};
  for (const k of FORWARD) {
    if (k === 'authorization') continue;
    const v = nodeReq.headers[k];
    if (v) h[k] = Array.isArray(v) ? v[0] : v;
  }
  h['authorization'] = 'Bearer public';
  if (!h['x-opencode-client']) h['x-opencode-client'] = 'cli';
  if (!h['content-type']) h['content-type'] = 'application/json';
  return h;
}

// ═══════════════════════════════════════════════════════════
//  OpenCode 会话/请求/项目 ID 生成（借鉴 jasonxu114514/opencode2api）
//  为上游提供稳定的 x-opencode-session / 唯一的 x-opencode-request /
//  稳定的 x-opencode-project，降低被上游误判为异常流量的概率
// ═══════════════════════════════════════════════════════════

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function stableID(prefix: string, value: string): string {
  return prefix + '_' + sha256Hex(prefix + '\x00' + value).slice(0, 24);
}

function randomID(prefix: string, size = 16): string {
  return prefix + '_' + crypto.randomBytes(size).toString('hex');
}

function firstNonEmpty(...values: (string | undefined | null)[]): string {
  for (const v of values) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t) return t;
  }
  return '';
}

function conversationSeed(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (!parsed) return '';
    if (typeof parsed.input === 'string' && parsed.input) return parsed.input;
    for (const field of ['messages', 'input']) {
      const arr = parsed[field];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        if (item.role !== 'user') continue;
        const content = JSON.stringify(item.content);
        if (content && content !== 'null') return content;
      }
    }
  } catch {}
  return '';
}

function injectOpencodeHeaders(headers: Record<string, string>, body: string): void {
  // session：优先客户端显式传入，否则用第一条用户消息做稳定种子
  let sessionSignal = firstNonEmpty(
    headers['x-opencode-session'],
    headers['x-session-id'],
    headers['conversation-id'],
  );
  if (!sessionSignal) {
    try {
      const parsed = JSON.parse(body);
      sessionSignal = firstNonEmpty(parsed?.conversation_id, parsed?.metadata?.session_id);
    } catch {}
  }
  if (!sessionSignal) sessionSignal = conversationSeed(body);
  if (!sessionSignal || sessionSignal === '{}') sessionSignal = randomID('fallback', 16);
  if (!headers['x-opencode-session']) headers['x-opencode-session'] = stableID('ses', sessionSignal);

  // request：每次请求唯一（同一次请求的重试保持不变，因为 dispatch 层只注入一次）
  if (!headers['x-opencode-request']) headers['x-opencode-request'] = randomID('req', 16);

  // project：默认值
  let projectSignal = firstNonEmpty(headers['x-opencode-project']);
  if (!projectSignal) {
    try {
      const parsed = JSON.parse(body);
      projectSignal = firstNonEmpty(parsed?.metadata?.project_id);
    } catch {}
  }
  if (!projectSignal) projectSignal = 'opencode2api:default-project';
  if (!headers['x-opencode-project']) headers['x-opencode-project'] = stableID('prj', projectSignal);
}

// ═══════════════════════════════════════════════════════════
//  SingBox 管理
// ═══════════════════════════════════════════════════════════

function loadSingboxNodes() {
  try {
    const nodesFile = path.join(SINGBOX_CONFIG_DIR, 'nodes.json');
    if (!fs.existsSync(nodesFile)) {
      singboxNodes = [];
      singboxNodeIndex = 0;
      return;
    }
    const data = JSON.parse(fs.readFileSync(nodesFile, 'utf-8'));
    singboxNodes = data.nodes || [];
    singboxNodeIndex = 0;
    console.log(`[SingBox] 已加载 ${singboxNodes.length} 个节点`);
  } catch (e: any) {
    console.error(`[SingBox] 加载节点失败: ${e.message}`);
    singboxNodes = [];
  }
}

async function initSingboxNode(): Promise<void> {
  if (singboxNodes.length === 0) return;
  const {SocksProxyAgent} = await import('socks-proxy-agent');
  const httpsMod = await import('node:https');
  // 逐个测试节点，找到第一个能连 opencode.ai 的
  const getRes = await fetch(`${SINGBOX_API_URL}/proxies/manual`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  const all = getRes && getRes.ok ? (await getRes.json() as any).all || [] : singboxNodes;
  const maxTest = Math.min(all.length, 60);
  for (let i = 0; i < maxTest; i++) {
    const node = all[i];
    try {
      await fetch(`${SINGBOX_API_URL}/proxies/manual`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: node }),
        signal: AbortSignal.timeout(3000),
      });
      await new Promise(r => setTimeout(r, 150));
    } catch {}
    const agent = new SocksProxyAgent(`socks5h://${SINGBOX_HOST}:${SINGBOX_SOCKS_PORT}`, { timeout: 8000 }) as unknown as https.Agent;
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = httpsMod.request('https://opencode.ai/zen/v1/models', {
          headers: { 'authorization': 'Bearer public', 'x-opencode-client': 'desktop' },
          agent, rejectUnauthorized: false, signal: AbortSignal.timeout(6000),
        }, (r) => { resolve(r.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.end();
      });
      if (ok) {
        singboxOk = true;
        console.log(`[SingBox] 初始化到可用节点: ${node} (index ${i}/${all.length})`);
        return;
      }
    } catch {}
  }
  singboxOk = false;
  console.warn('[SingBox] 前 60 个节点均不可用，将回退直连');
}

async function checkSingboxHealth(): Promise<boolean> {
  if (SINGBOX_MODE !== 'on') { singboxOk = false; return false; }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${SINGBOX_API_URL}/proxies`, { signal: controller.signal });
    clearTimeout(timer);
    singboxOk = res.ok;
    return res.ok;
  } catch {
    singboxOk = false;
    return false;
  }
}

async function switchSingboxNode(tried: Set<string> = new Set()): Promise<string | null> {
  if (SINGBOX_MODE !== 'on') return null;
  try {
    // 获取 manual selector 的全部节点和当前选中
    const getRes = await fetch(`${SINGBOX_API_URL}/proxies/manual`, { signal: AbortSignal.timeout(3000) });
    if (!getRes.ok) return null;
    const data = await getRes.json() as any;
    const all = data.all || [];
    const now = data.now || '';
    if (all.length === 0) return null;
    // 顺序找下一个未尝试的节点
    const startIdx = all.indexOf(now);
    for (let i = 1; i <= all.length; i++) {
      const idx = (startIdx + i) % all.length;
      const node = all[idx];
      if (tried.has(node)) continue;
      const putRes = await fetch(`${SINGBOX_API_URL}/proxies/manual`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: node }),
        signal: AbortSignal.timeout(3000),
      });
      if (putRes.ok) {
        console.log(`[SingBox] 切换节点 → ${node} (${idx}/${all.length})`);
        return node;
      }
    }
    return null;
  } catch (e: any) {
    console.warn(`[SingBox] 切换节点异常: ${e.message}`);
    return null;
  }
}

async function reloadSingboxConfig(): Promise<boolean> {
  if (SINGBOX_MODE !== 'on') return false;
  try {
    // 通过 Docker socket 重启 opengate-singbox 容器
    const sockPath = '/var/run/docker.sock';
    if (!fs.existsSync(sockPath)) {
      console.warn('[SingBox] Docker socket 不可用，跳过重载');
      return false;
    }
    await new Promise<void>((resolve, reject) => {
      const client = net.createConnection(sockPath, () => {
        client.write(
          'POST /containers/opengate-singbox/restart HTTP/1.1\r\n' +
          'Host: localhost\r\n' +
          'Content-Length: 0\r\n' +
          '\r\n'
        );
      });
      let resp = '';
      client.on('data', (chunk) => { resp += chunk.toString(); });
      client.on('end', () => {
        if (resp.includes('204') || resp.includes('200')) resolve();
        else reject(new Error(resp.split('\r\n')[0]));
      });
      client.on('error', reject);
      client.setTimeout(10000, () => { client.destroy(); reject(new Error('timeout')); });
    });
    console.log('[SingBox] 配置已重载，容器已重启');
    // 等待 sing-box 启动
    await new Promise(resolve => setTimeout(resolve, 3000));
    await checkSingboxHealth();
    loadSingboxNodes();
    return true;
  } catch (e: any) {
    console.error(`[SingBox] 重载失败: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  订阅管理
// ═══════════════════════════════════════════════════════════

interface SubscriptionConfig {
  url: string;
  token: string;
  updatedAt: number;
}

function loadSubscription(): SubscriptionConfig | null {
  try {
    if (!fs.existsSync(SUBSCRIPTION_FILE)) return null;
    return JSON.parse(fs.readFileSync(SUBSCRIPTION_FILE, 'utf-8'));
  } catch { return null; }
}

function saveSubscription(sub: SubscriptionConfig) {
  fs.writeFileSync(SUBSCRIPTION_FILE, JSON.stringify(sub, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────
//  订阅 URL 校验（SSRF 防护）
//
//  /api/subscription 的 url 直接喂给 fetch()。无校验的话，
//  配合 /api/* 无鉴权，任何人都能让服务器去请求内网地址 /
//  云元数据接口（http://169.254.169.254/...）拿凭据。
//
//  允许 http/https，且主机名不能解析到私有/保留网段。
//  需要拉内网订阅时用 ALLOW_PRIVATE_FETCH=1 显式放开。
// ─────────────────────────────────────────────────────────────
const ALLOW_PRIVATE_FETCH = process.env.ALLOW_PRIVATE_FETCH === '1';

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(n => parseInt(n, 10));
  if (p.length !== 4 || p.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true; // 解析不出来一律当危险
  const [a, b] = p;
  if (a === 10) return true;                              // 10/8
  if (a === 127) return true;                             // loopback
  if (a === 0) return true;                               // 0/8
  if (a === 172 && b >= 16 && b <= 31) return true;       // 172.16/12
  if (a === 192 && b === 168) return true;                // 192.168/16
  if (a === 169 && b === 254) return true;                // link-local 含云元数据 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT 100.64/10
  if (a >= 224) return true;                              // multicast + reserved
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  // 去掉 zone id 和方括号
  const h = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (h === '::' || h === '::1') return true;              // unspecified / loopback
  if (h.startsWith('fe80')) return true;                   // link-local
  if (/^f[cd]/.test(h)) return true;                        // fc00::/7 unique-local
  // IPv4 映射地址 ::ffff:a.b.c.d —— 直接按 IPv4 判
  const mapped = h.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === 'metadata.google.internal') return true;       // GCP 元数据
  if (h === 'metadata' || h.endsWith('.metadata')) return true;
  // IPv6 字面量：[::1] → 去掉方括号后交给 isBlockedIPv6
  if (h.includes(':')) return isBlockedIPv6(h);
  const v4 = h.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return isPrivateIPv4(v4[1]);
  return false;
}

async function assertFetchableUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式非法');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，收到 ${u.protocol}`);
  }
  if (ALLOW_PRIVATE_FETCH) return;
  if (isBlockedHost(u.hostname)) {
    throw new Error(`目标地址 ${u.hostname} 属于内网/保留网段，已拒绝（需要的话设 ALLOW_PRIVATE_FETCH=1 放开）`);
  }
  // 域名可能被 DNS 解析到内网（DNS rebinding），这里解析一次再判。
  // 解析失败一律拒绝 —— 拿不到地址就没法确认安全，放行等于把
  // 判断权交给攻击者的 DNS。
  const { addresses } = await dnsLookupSafe(u.hostname);
  if (addresses.length === 0) {
    throw new Error(`${u.hostname} DNS 解析失败，无法确认地址安全性，已拒绝`);
  }
  for (const addr of addresses) {
    const bad = addr.family === 4 ? isPrivateIPv4(addr.address) : isBlockedIPv6(addr.address);
    if (bad) {
      throw new Error(`${u.hostname} 解析到内网/保留地址 ${addr.address}，已拒绝`);
    }
  }
}

// 生成 sing-box 配置（复用 glm-proxy 的 vless 解析逻辑）
async function generateSingboxConfig(sub: SubscriptionConfig): Promise<number> {
  await assertFetchableUrl(sub.url);
  // 拉取订阅
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let raw: string;
  try {
    const res = await fetch(sub.url, {
      headers: { 'user-agent': 'curl/8.0' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`订阅拉取失败 HTTP ${res.status}`);
    raw = await res.text();
  } catch (e: any) {
    clearTimeout(timer);
    throw new Error(`订阅拉取异常: ${e.message}`);
  }
  clearTimeout(timer);

  // base64 解码
  let decoded = '';
  try {
    const normalized = raw.replace(/\s+/g, '');
    decoded = Buffer.from(normalized, 'base64').toString('utf-8');
    if (!decoded.trim().startsWith('vless://')) throw new Error('not vless');
  } catch {
    decoded = raw;
  }

  // 解析 vless:// 行
  const lines = decoded.split('\n').map(l => l.trim()).filter(Boolean);
  let outbounds: any[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('vless://')) continue;
    const ob = parseVless(line);
    if (ob && !seen.has(ob['tag'])) {
      seen.add(ob['tag']);
      outbounds.push(ob);
    }
  }
  if (outbounds.length === 0) throw new Error('订阅中未解析到任何 vless 节点');

  // 全部节点拉取，urltest 逐个测速（2026-08-12 用户要求取消上限）

  const nodeTags = outbounds.map(o => o['tag']);
  const config = {
    log: { level: 'warn' as const, timestamp: true },
    inbounds: [
      { type: 'http' as const, tag: 'http-in', listen: '0.0.0.0', listen_port: SINGBOX_HTTP_PORT },
      { type: 'socks' as const, tag: 'socks-in', listen: '0.0.0.0', listen_port: SINGBOX_SOCKS_PORT },
    ],
    outbounds: [
      { type: 'selector' as const, tag: 'manual', outbounds: nodeTags, default: nodeTags[0] },
      { type: 'urltest' as const, tag: 'auto', outbounds: nodeTags,
        url: 'https://opencode.ai/zen/v1/models', interval: '40m', tolerance: 100, idle_timeout: '60m' },
      ...outbounds,
      { type: 'direct' as const, tag: 'direct' },
      { type: 'block' as const, tag: 'block' },
    ],
    route: {
      rules: [{ inbound: ['http-in', 'socks-in'], outbound: 'auto' }],
      final: 'auto' as const,
    },
    experimental: {
      clash_api: {
        external_controller: `0.0.0.0:${SINGBOX_API_PORT}`,
        external_ui: '',
        secret: '',
        default_mode: 'rule' as const,
      },
    },
  };

  fs.mkdirSync(SINGBOX_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(SINGBOX_CONFIG_DIR, 'singbox_config.json'), JSON.stringify(config, null, 2), 'utf-8');
  fs.writeFileSync(path.join(SINGBOX_CONFIG_DIR, 'nodes.json'), JSON.stringify({ nodes: nodeTags, count: nodeTags.length }), 'utf-8');
  return nodeTags.length;
}

function parseVless(uri: string): any {
  const body = uri.slice('vless://'.length);
  const withHash = body.split('#', 1)[0] || body;
  const at = withHash.lastIndexOf('@');
  if (at === -1) return null;
  const uuid = withHash.slice(0, at);
  let rest = withHash.slice(at + 1);
  let query = '';
  if (rest.includes('?')) { const i = rest.indexOf('?'); query = rest.slice(i + 1); rest = rest.slice(0, i); }
  const params = Object.fromEntries(new URLSearchParams(query));
  const hostPort = rest.split('?')[0];
  const lastColon = hostPort.lastIndexOf(':');
  const host = hostPort.slice(0, lastColon);
  const port = parseInt(hostPort.slice(lastColon + 1), 10);
  if (!host || isNaN(port)) return null;
  return {
    type: 'vless', tag: `n-${host}-${port}`,
    server: host, server_port: port, uuid,
    tls: {
      enabled: params['security'] === 'tls',
      server_name: params['sni'] || params['host'] || host,
      utls: { enabled: true, fingerprint: params['fp'] || 'chrome' },
    },
    transport: { type: 'ws', path: params['path'] || '/', headers: { Host: params['host'] || host } },
  };
}

// ═══════════════════════════════════════════════════════════
//  Key 管理
// ═══════════════════════════════════════════════════════════

function loadKeys() {
  try {
    if (!fs.existsSync(KEYS_FILE)) {
      apiKeys = {};
      // 默认 key
      const defaultKey = 'sk-default';
      apiKeys[defaultKey] = {
        key: defaultKey, name: 'default', enabled: true,
        createdAt: Date.now(), lastUsedAt: 0,
        totalRequests: 0, totalTokens: 0,
        maxConcurrency: 5, maxRequests: 1000000,
        requestCount: 0, expiresAt: Date.now() + 365 * 86400000,
      };
      saveKeys();
      console.log('[Key] 默认 key 已创建');
      return;
    }
    apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
    console.log(`[Key] 已加载 ${Object.keys(apiKeys).length} 个 key`);
  } catch (e: any) {
    console.error(`[Key] 加载失败: ${e.message}`);
    apiKeys = {};
  }
}

function saveKeys() {
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(apiKeys, null, 2), 'utf-8');
  } catch (e: any) {
    console.error(`[Key] 保存失败: ${e.message}`);
  }
}

function validateKey(key: string): { valid: boolean; record?: ApiKeyRecord; reason?: string } {
  const record = apiKeys[key];
  if (!record) return { valid: false, reason: 'key 不存在' };
  if (!record.enabled) return { valid: false, reason: 'key 已禁用' };
  if (record.expiresAt !== 0 && Date.now() > record.expiresAt) return { valid: false, reason: 'key 已过期' };
  if (record.maxRequests !== 0 && record.requestCount >= record.maxRequests) return { valid: false, reason: '请求次数已达上限' };
  const current = activeRequests[key] || 0;
  if (record.maxConcurrency !== 0 && current >= record.maxConcurrency) return { valid: false, reason: '并发数已达上限' };
  return { valid: true, record };
}

function acquireKey(key: string) {
  activeRequests[key] = (activeRequests[key] || 0) + 1;
}

function releaseKey(key: string) {
  if (activeRequests[key] > 0) activeRequests[key]--;
}

// keys.json 落盘节流。
//
// 原来每次请求都 saveKeys()（同步 writeFileSync 全量重写），
// 高 QPS 下是明确的 I/O 瓶颈，而且并发写同一文件有损坏风险。
// 改成内存计数 + 延迟落盘：先进内存保证限流判断读到最新值，
// 写盘按 KEY_FLUSH_MS 合并，并在退出前 flush。
const KEY_FLUSH_MS = 5000;
let keyDirty = false;
let keyFlushTimer: NodeJS.Timeout | null = null;

function scheduleKeyFlush() {
  keyDirty = true;
  if (keyFlushTimer) return;
  keyFlushTimer = setTimeout(() => {
    keyFlushTimer = null;
    if (!keyDirty) return;
    keyDirty = false;
    saveKeys();
  }, KEY_FLUSH_MS);
  // 不要因为这个定时器把进程吊住
  if (typeof keyFlushTimer.unref === 'function') keyFlushTimer.unref();
}

function recordKeyUsage(key: string, tokens: number) {
  const record = apiKeys[key];
  if (record) {
    record.totalRequests++;
    record.totalTokens += tokens;
    record.requestCount++;
    record.lastUsedAt = Date.now();
    scheduleKeyFlush();
  }
}

// ═══════════════════════════════════════════════════════════
//  审计日志
// ═══════════════════════════════════════════════════════════

function audit(status: number, latencyMs: number, keyId: string, path: string, body?: string) {
  let model = '';
  let promptTokens = 0, completionTokens = 0, totalTokens = 0;
  let cacheCreation = 0, cacheRead = 0;
  try {
    if (body) {
      const parsed = JSON.parse(body);
      model = parsed.model || '';
      if (parsed.usage) {
        promptTokens = parsed.usage.prompt_tokens || 0;
        completionTokens = parsed.usage.completion_tokens || 0;
        totalTokens = parsed.usage.total_tokens || 0;
        cacheRead = parsed.usage.prompt_cache_hit_tokens || 0;
      }
    }
  } catch {}
  const entry: AuditEntry = {
    ts: Date.now(), keyId, model, promptTokens, completionTokens, totalTokens,
    cacheCreation, cacheRead, latencyMs, status,
  };
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT) auditLog.shift();
  appendAudit(entry);
}

// audit.jsonl 只 append、从不轮转，长期跑会把磁盘写满。
// 按大小轮转，保留最近 N 份。
const AUDIT_MAX_BYTES = parseInt(process.env.AUDIT_MAX_BYTES || `${64 * 1024 * 1024}`);
const AUDIT_KEEP = parseInt(process.env.AUDIT_KEEP || '5');
let auditBytes = 0;

function appendAudit(entry: AuditEntry) {
  const line = JSON.stringify(entry) + '\n';
  try {
    // 启动时算一次现有大小，之后增量维护
    if (!auditBytes) {
      auditBytes = fs.existsSync(AUDIT_FILE) ? fs.statSync(AUDIT_FILE).size : 0;
    }
    if (auditBytes + line.length > AUDIT_MAX_BYTES) {
      rotateAudit();
    }
    fs.appendFileSync(AUDIT_FILE, line);
    auditBytes += line.length;
  } catch (e: any) {
    console.error(`[Audit] 写入失败: ${e.message}`);
  }
}

function rotateAudit() {
  try {
    // audit.jsonl → audit.jsonl.1 → … → audit.jsonl.(KEEP)
    for (let i = AUDIT_KEEP - 1; i >= 1; i--) {
      const from = `${AUDIT_FILE}.${i}`;
      const to = `${AUDIT_FILE}.${i + 1}`;
      if (fs.existsSync(from)) {
        if (i + 1 > AUDIT_KEEP) { fs.unlinkSync(from); continue; }
        fs.renameSync(from, to);
      }
    }
    if (fs.existsSync(AUDIT_FILE)) fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    auditBytes = 0;
    console.log(`[Audit] 已轮转（上限 ${Math.floor(AUDIT_MAX_BYTES / 1024 / 1024)}MB）`);
  } catch (e: any) {
    console.error(`[Audit] 轮转失败: ${e.message}`);
  }
}

function loadAuditLog() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return;
    const lines = fs.readFileSync(AUDIT_FILE, 'utf-8').split('\n').filter(Boolean);
    const count = Math.min(lines.length, 500);
    for (let i = lines.length - count; i < lines.length; i++) {
      try { auditLog.push(JSON.parse(lines[i])); } catch {}
    }
    if (auditLog.length > MAX_AUDIT) auditLog.splice(0, auditLog.length - MAX_AUDIT);
    console.log(`[审计] 已加载 ${auditLog.length} 条历史记录`);
  } catch (e: any) {
    console.error(`[审计] 加载失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  模型缓存
// ═══════════════════════════════════════════════════════════

async function fetchModelsFromUpstream(): Promise<any[]> {
  try {
    const res = await fetch(`${UPSTREAM}/v1/models`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return cachedModels;
    const data = await res.json() as any;
    const models = data.data || data.models || [];
    // 只保留 -free 后缀的模型，和 /v1/models 的过滤规则保持一致，
    // 免得面板下拉框列出一堆实际调不通的付费模型
    const free = models.filter((m: any) => {
      const id = String(m.id || '');
      return id.endsWith('-free') || id === 'big-pickle';
    });
    cachedModels = free.length ? free : models;
    cachedModelsTime = Date.now();
    saveModelsCache();
    return cachedModels;
  } catch {
    return cachedModels;
  }
}

function saveModelsCache() {
  try {
    fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ models: cachedModels, time: cachedModelsTime }, null, 2), 'utf-8');
  } catch {}
}

function loadModelsCache() {
  try {
    if (!fs.existsSync(MODELS_CACHE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf-8'));
    if (data.models) {
      cachedModels = data.models;
      cachedModelsTime = data.time || 0;
      return true;
    }
    return false;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════
//  转发（doHttps / doHttpsStream）
// ═══════════════════════════════════════════════════════════

function doHttps(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent?: https.Agent,
): Promise<{ status: number; body: string }> {
  const { authorization, Authorization, host, Host, ...cleanHeaders } = headers;
  cleanHeaders['authorization'] = 'Bearer public';
  cleanHeaders['x-opencode-client'] = 'cli';
  delete cleanHeaders['content-length'];
  delete cleanHeaders['transfer-encoding'];
  delete cleanHeaders['connection'];
  cleanHeaders['user-agent'] = 'opencode/1.18.16 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';
  delete cleanHeaders['accept-encoding'];
  delete cleanHeaders['host'];
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    const opts: any = { method, headers: cleanHeaders, signal: ac.signal, rejectUnauthorized: false };
    if (agent) opts.agent = agent;
    const req = https.request(`${UPSTREAM}${path}`, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 200, body: Buffer.concat(chunks).toString('utf-8') }));
      res.on('error', reject);
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

function doHttpsStream(
  path: string, method: string, headers: Record<string, string>,
  body: string | undefined, agent?: https.Agent,
): Promise<{ status: number; stream: ReadableStream<Uint8Array>; headers: Record<string, string> }> {
  const { authorization, Authorization, host, Host, ...cleanHeaders } = headers;
  cleanHeaders['authorization'] = 'Bearer public';
  cleanHeaders['x-opencode-client'] = 'cli';
  delete cleanHeaders['content-length'];
  delete cleanHeaders['transfer-encoding'];
  delete cleanHeaders['connection'];
  cleanHeaders['user-agent'] = 'opencode/1.18.16 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14';
  delete cleanHeaders['accept-encoding'];
  delete cleanHeaders['host'];
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), STREAM_TIMEOUT);
    const opts: any = { method, headers: cleanHeaders, signal: ac.signal, rejectUnauthorized: false };
    if (agent) opts.agent = agent;
    const req = https.request(`${UPSTREAM}${path}`, opts, (res) => {
      clearTimeout(timer);
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v) resHeaders[k] = Array.isArray(v) ? v[0] : v;
      }
      res.on('end', () => {});
      res.on('error', () => {});
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          res.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          res.on('end', () => { try { controller.close(); } catch {} });
          res.on('error', (e: Error) => { try { controller.error(e); } catch {} });
        },
      });
      resolve({ status: res.statusCode || 200, stream, headers: resHeaders });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════
//  SingBox 出站调度
// ═══════════════════════════════════════════════════════════

async function getSingboxAgent(): Promise<https.Agent | undefined> {
  if (SINGBOX_MODE !== 'on' || !singboxOk) return undefined;
  try {
    const { SocksProxyAgent } = await import('socks-proxy-agent');
    return new SocksProxyAgent(SINGBOX_SOCKS_URL, { timeout: TIMEOUT }) as unknown as https.Agent;
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════
//  主请求处理 dispatch
// ═══════════════════════════════════════════════════════════

// 判断是否需要走 sing-box 代理（排除本地直连路径）
function shouldUseProxy(url: string | undefined): boolean {
  if (SINGBOX_MODE !== 'on') return false;
  if (!url) return true;
  const directHosts = ['127.0.0.1', 'localhost', '192.168.', '10.', '172.16.', '172.17.', '172.18.', '172.19.'];
  const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
  return !directHosts.some(h => host.startsWith(h));
}

function extractUsageFromResponse(respBody: string): { tokens: number; model: string } {
  try {
    const parsed = JSON.parse(respBody);
    const model = parsed.model || '';
    const usage = parsed.usage;
    if (usage) {
      return {
        tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        model,
      };
    }
  } catch {}
  return { tokens: 0, model: '' };
}

// thinking 模型（deepseek-v4-flash-free 等）要求多轮历史里每条 assistant
// 消息都必须带 reasoning_content 字段；QwenPaw 上下文压缩后部分 assistant
// 消息缺失该字段，上游 opencode.ai/zen 会返回 400
// "The reasoning_content in the thinking mode must be passed back to the API"，
// 导致任务中断。此函数为缺失的 assistant 消息补上空 reasoning_content。
function patchMissingReasoningContent(reqBody: string): string {
  if (!reqBody) return reqBody;
  try {
    const parsed = JSON.parse(reqBody);
    if (!parsed || !Array.isArray(parsed.messages)) return reqBody;
    let changed = false;
    for (const m of parsed.messages) {
      if (m && m.role === 'assistant' && !('reasoning_content' in m)) {
        m.reasoning_content = '';
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : reqBody;
  } catch {
    return reqBody;
  }
}

async function dispatchNonStream(
  reqPath: string, reqMethod: string, reqHeaders: Record<string, string>,
  reqBody: string, keyId: string,
): Promise<{ status: number; body: string }> {
  // 补 -free 后缀（兼容旧 opencode-gate 行为）
  if (reqBody && reqPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(reqBody);
      if (parsed.model && !parsed.model.endsWith('-free')) {
        parsed.model = parsed.model + '-free';
      }
      reqBody = JSON.stringify(parsed);
    } catch {}
    // thinking 模型要求每条 assistant 消息都带 reasoning_content，缺失则补空
    reqBody = patchMissingReasoningContent(reqBody);
  }
  injectOpencodeHeaders(reqHeaders, reqBody);
  let lastErr: any = null;
  let directFallback = false;
  const triedNodes = new Set<string>();
  console.log(`[非流式] 开始请求 ${reqPath} singboxOk=${singboxOk} key=${keyId.slice(0,7)}`);
  for (let attempt = 0; attempt < 20; attempt++) {
    const start = Date.now();
    let res: { status: number; body: string };
    try {
      if (directFallback || !singboxOk) {
        res = await doHttps(reqPath, reqMethod, reqHeaders, reqBody);
      } else {
        const agent = await getSingboxAgent();
        if (agent) {
          res = await doHttps(reqPath, reqMethod, reqHeaders, reqBody, agent);
        } else {
          res = await doHttps(reqPath, reqMethod, reqHeaders, reqBody);
        }
      }
    } catch (e: any) {
      lastErr = e;
      if (!directFallback && singboxOk) {
        console.log(`[非流式] 代理连接异常，切换节点: ${e.message?.slice(0, 60) || e}`);
        await switchSingboxNode(triedNodes);
        continue;
      }
      stats.errors++;
      const fb = JSON.stringify({ error: { message: `请求失败: ${e.message || '未知错误'}` } });
      audit(502, 0, keyId, reqPath);
      return { status: 502, body: fb };
    }
    const latency = Date.now() - start;
    console.log(`[非流式] attempt ${attempt} 上游响应 ${res.status} (${latency}ms): ${res.body.slice(0,120)}`);
    if (res.status === 429) {
      stats.rateLimited++;
      console.log(`[429] 上游限流，切换节点 (attempt ${attempt + 1})`);
      if (singboxOk) {
        try {
          const r = await fetch(`${SINGBOX_API_URL}/proxies/manual`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) { const d = await r.json() as any; if (d.now) triedNodes.add(d.now); }
        } catch {}
        await switchSingboxNode(triedNodes);
      }
      if (attempt >= 5) directFallback = true;
      continue;
    }
    if (res.status >= 200 && res.status < 300) stats.success++;
    else if (res.status >= 500) {
      stats.errors++;
      // 500 是上游内部错误，切换节点没用，直接兜底直连
      directFallback = true;
      continue;
    }
    stats.total++;
    audit(res.status, latency, keyId, reqPath, res.body);
    return res;
  }
  // 直连兜底
  try {
    const finalRes = await doHttps(reqPath, reqMethod, reqHeaders, reqBody);
    stats.total++;
    audit(finalRes.status, 0, keyId, reqPath, finalRes.body);
    return finalRes;
  } catch (e: any) {
    lastErr = e;
  }
  stats.errors++;
  const fb = JSON.stringify({ error: { message: `上游请求失败: ${lastErr?.message || '未知错误'}` } });
  audit(502, 0, keyId, reqPath);
  return { status: 502, body: fb };
}async function dispatchStream(
  reqPath: string, reqMethod: string, reqHeaders: Record<string, string>,
  reqBody: string, keyId: string,
): Promise<{ status: number; stream: ReadableStream<Uint8Array>; headers: Record<string, string> }> {
  // 补 -free 后缀（兼容旧 opencode-gate 行为，与非流式一致）
  if (reqBody && reqPath.includes('/chat/completions')) {
    try {
      const parsed = JSON.parse(reqBody);
      if (parsed.model && !parsed.model.endsWith('-free')) {
        parsed.model = parsed.model + '-free';
      }
      reqBody = JSON.stringify(parsed);
    } catch {}
    // thinking 模型要求每条 assistant 消息都带 reasoning_content，缺失则补空
    reqBody = patchMissingReasoningContent(reqBody);
  }
  injectOpencodeHeaders(reqHeaders, reqBody);
  let lastErr: any = null;
  let directFallback = false;
  const triedNodes = new Set<string>();
  for (let attempt = 0; attempt < 20; attempt++) {
    const start = Date.now();
    let res: { status: number; stream: ReadableStream<Uint8Array>; headers: Record<string, string> };
    try {
      if (directFallback || !singboxOk) {
        res = await doHttpsStream(reqPath, reqMethod, reqHeaders, reqBody);
      } else {
        const agent = await getSingboxAgent();
        if (agent) {
          res = await doHttpsStream(reqPath, reqMethod, reqHeaders, reqBody, agent);
        } else {
          res = await doHttpsStream(reqPath, reqMethod, reqHeaders, reqBody);
        }
      }
    } catch (e: any) {
      lastErr = e;
      if (!directFallback && singboxOk) {
        console.log(`[流式] 代理连接异常，切换节点: ${e.message?.slice(0, 60) || e}`);
        await switchSingboxNode(triedNodes);
        continue;
      }
      stats.errors++;
      const errBody = JSON.stringify({ error: { message: `流式请求失败: ${e.message || '未知错误'}` } });
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(errBody)); controller.close(); } });
      audit(502, 0, keyId, reqPath);
      return { status: 502, stream, headers: {} };
    }
    if (res.status === 429) {
      stats.rateLimited++;
      console.log(`[429] 流式上游限流，切换节点 (attempt ${attempt + 1})`);
      if (singboxOk) {
        try {
          const r = await fetch(`${SINGBOX_API_URL}/proxies/manual`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) { const d = await r.json() as any; if (d.now) triedNodes.add(d.now); }
        } catch {}
        await switchSingboxNode(triedNodes);
      }
      if (attempt >= 5) directFallback = true;
      continue;
    }
    stats.total++;
    if (res.status >= 200 && res.status < 300) stats.success++;
    else if (res.status >= 500) {
      stats.errors++;
      // 500 是上游内部错误，切换节点没用，直接兜底直连
      directFallback = true;
      continue;
    }
    audit(res.status, Date.now() - start, keyId, reqPath);
    return res;
  }
  // 直连兜底
  try {
    const finalRes = await doHttpsStream(reqPath, reqMethod, reqHeaders, reqBody);
    stats.total++;
    audit(finalRes.status, 0, keyId, reqPath);
    return finalRes;
  } catch (e: any) {
    lastErr = e;
  }
  stats.errors++;
  const errBody = JSON.stringify({ error: { message: `流式请求失败: ${lastErr?.message || '未知错误'}` } });
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(errBody)); controller.close(); } });
  audit(502, 0, keyId, reqPath);
  return { status: 502, stream, headers: {} };
}

// 请求体上限：LLM 对话 body 天然可能很大（含长上下文），
// 但不设上限的话任何人都能 POST 一个超大 body 把进程 OOM 掉。
const MAX_BODY = parseInt(process.env.MAX_BODY || `${32 * 1024 * 1024}`);

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`请求体超过上限 ${Math.floor(limit / 1024 / 1024)}MB`);
    this.name = 'BodyTooLargeError';
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const done = (fn: () => void) => { if (settled) return; settled = true; fn(); };

    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY) {
        // 只 pause 不 destroy —— destroy 会立刻掐掉 socket，
        // 客户端收到的是 connection reset 而不是 413。
        // socket 由 handler 在写完 413 响应后再关。
        req.pause();
        done(() => reject(new BodyTooLargeError(MAX_BODY)));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(() => resolve(Buffer.concat(chunks).toString('utf-8'))));
    req.on('error', (e) => done(() => reject(e)));
    // 超限后上游可能还在推数据，丢弃即可，别再进 chunks
    req.on('aborted', () => done(() => reject(new Error('请求被中断'))));
  });
}

function json(res: http.ServerResponse, status: number, obj: any) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const PUBLIC_DIR = path.join(process.cwd(), 'public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** 从 public/ 目录安全地提供静态文件；返回 true 表示已处理响应 */
function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  try {
    // 面板 index.html 里写的是 /public/app.js、/public/style.css，
    // 而 PUBLIC_DIR 本身就是 <cwd>/public。若直接拼路径会去找
    // <cwd>/public/public/app.js（不存在），于是落到 SPA fallback 返回
    // index.html —— 浏览器拿 text/html 当 JS 执行，静默失败、页面永远卡在
    // 「加载中...」。这里先剥掉 /public 前缀，让两种写法都能命中。
    //
    // 注意：path.normalize 在 Windows 上会把 / 转成 \，
    // 所以先统一成正斜杠再做前缀判断，否则本地怎么测都不对。
    let safePath = path.normalize(urlPath).replace(/\\/g, '/');
    safePath = safePath.replace(/^\/+/, '/');
    if (safePath === '/public' || safePath === '/public/') safePath = '/';
    else if (safePath.startsWith('/public/')) safePath = safePath.slice('/public'.length);

    // 解析到 public 目录内的真实路径，防目录穿越
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) return false;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
//  HTTP 服务器
// ═══════════════════════════════════════════════════════════

async function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url || '/';
  const method = req.method || 'GET';
  const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsed.pathname;

  try {
    // ───────────────────────────────────────────────
    //  管理接口鉴权
    //  配了 ADMIN_TOKEN 才会拦；/api/status /api/ping /api/models 放行给面板首屏
    // ───────────────────────────────────────────────
    if (pathname.startsWith('/api/') && !adminAuthorized(req, pathname, parsed)) {
      json(res, 401, {
        error: { message: '需要管理权限：带 Authorization: Bearer <ADMIN_TOKEN> 或 X-Admin-Token 头重试' },
        hint: '未配置 ADMIN_TOKEN 时不启用鉴权。公网部署请在 compose 里加 -e ADMIN_TOKEN=<随机长串>',
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /ping  — 健康检查（Docker HEALTHCHECK 用）
    //  必须在此处处理：曾用 server.on('request') 额外注册监听器，
    //  导致 handler 已写完 404 后再 writeHead(200) 触发 ERR_HTTP_HEADERS_SENT 崩溃。
    // ───────────────────────────────────────────────
    if (pathname === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('pong');
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /  — 状态页
    // ───────────────────────────────────────────────
    if (pathname === '/' && method === 'GET') {
      // 新管理面板：public/index.html 存在则优先返回，否则回退内嵌状态页
      const idxPath = PUBLIC_DIR + '/index.html';
      if (fs.existsSync(idxPath)) {
        const data = fs.readFileSync(idxPath);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>opencode-gate</title></head>
<body style="font-family:monospace;margin:2em">
<h2>🚀 opencode-gate (SingBox 版)</h2>
<p>运行时间: ${Math.floor((Date.now() - START_TIME) / 1000)}s</p>
<p>SingBox: ${SINGBOX_MODE === 'on' ? (singboxOk ? '✅ 正常' : '❌ 离线') : '⏹️ 关闭'}</p>
<p>节点: ${singboxNodes.length} 个</p>
<p>Key: ${Object.keys(apiKeys).length} 个</p>
<p>请求: ${stats.total} (成功 ${stats.success} / 限流 ${stats.rateLimited} / 错误 ${stats.errors})</p>
<p><a href="/status">/status</a> — <a href="/api/keys">/api/keys</a> — <a href="/api/audit">/api/audit</a> — <a href="/api/logs">/api/logs</a> — <a href="/api/models">/api/models</a></p>
</body></html>`);
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /status  — 简要状态
    // ───────────────────────────────────────────────
    if (pathname === '/status' && method === 'GET') {
      json(res, 200, {
        uptime: Date.now() - START_TIME,
        singbox: { mode: SINGBOX_MODE, ok: singboxOk, nodes: singboxNodes.length, currentNode: singboxNodeIndex },
        keys: Object.keys(apiKeys).length,
        stats, activeRequests: Object.values(activeRequests).reduce((a, b) => a + b, 0),
        cachedModels: cachedModels.length,
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/status  — 面板仪表盘用的完整状态
    //  面板是照 gate-docker.ts 写的，调 /api/status，而本入口（gate.ts）
    //  的状态接口叫 /status，字段名也不同 → 面板永远拿不到数据。
    //  这里把两边字段名对齐，pool/proxy 相关的用空值兜底。
    // ───────────────────────────────────────────────
    if (pathname === '/api/status' && method === 'GET') {
      const keyRecords = Object.values(apiKeys).map((k: any) => ({ ...k, fullKey: k.key }));
      json(res, 200, {
        uptime: Date.now() - START_TIME,
        uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
        version: '0.2.0',
        mode: 'singbox',
        // 面板读这几个字段
        totalApiKeys: keyRecords.length,
        activeKeys: Object.values(activeRequests).filter((n: number) => n > 0).length,
        maxActiveKeys: 20,
        slotsPerKey: 3,
        candidatesCount: 0,
        pools: [],
        proxyCount: 0,
        aliveProxies: 0,
        // SingBox 版没有 WARP，对齐成"关闭"
        warpAvailable: false,
        warpMode: 'off',
        warpStatus: 'stopped',
        warpSkipUntil: 0,
        // SingBox 专属字段
        singbox: { mode: SINGBOX_MODE, ok: singboxOk, nodes: singboxNodes.length, currentNode: singboxNodeIndex },
        // 代理源相关（SingBox 版没有代理池概念）
        sources: [],
        proxyRefreshMs: runtimeConfig.proxyRefreshMs || 0,
        stats,
        activeRequests: Object.values(activeRequests).reduce((a, b) => a + b, 0),
        cachedModels: cachedModels.length,
        keys: keyRecords,
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/sources  — SingBox 版没有公共代理源，返回空列表占位
    // ───────────────────────────────────────────────
    if (pathname === '/api/sources' && method === 'GET') {
      json(res, 200, { sources: [] });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/proxies  — SingBox 版没有代理池，返回空列表占位
    // ───────────────────────────────────────────────
    if (pathname === '/api/proxies' && method === 'GET') {
      json(res, 200, { proxies: [], total: 0 });
      return;
    }

    // ───────────────────────────────────────────────
    //  面板按钮发的几个 POST（代理池/代理源相关）
    //  SingBox 版没有这些子系统，统一返回成功并说明不可用，
    //  免得面板弹「操作失败」红 toast。
    // ───────────────────────────────────────────────
    if (method === 'POST' && (
      pathname === '/api/refresh' ||
      pathname === '/api/promote' ||
      pathname === '/api/sources/refresh' ||
      pathname === '/api/released/probe'
    )) {
      json(res, 200, {
        success: true,
        applied: false,
        message: 'SingBox 版没有代理池子系统，该操作无实际效果（代理由 sing-box 订阅节点提供）',
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/config  — 面板「系统配置」页读这个
    // ───────────────────────────────────────────────
    if (pathname === '/api/config' && method === 'GET') {
      json(res, 200, {
        port: PORT,
        maxActiveKeys: 20,
        slotsPerKey: 3,
        slotCount: 3,
        proxyRefreshMs: runtimeConfig.proxyRefreshMs || 0,
        warpMode: 'off',
        fallbackProxy: '',
        apiKey: API_KEY,
        // SingBox 相关
        singboxMode: SINGBOX_MODE,
        singboxHost: SINGBOX_HOST,
        singboxHttpPort: SINGBOX_HTTP_PORT,
        singboxSocksPort: SINGBOX_SOCKS_PORT,
        singboxApiPort: SINGBOX_API_PORT,
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/config  — 面板「系统配置」页的保存按钮
    //  SingBox 版的 port / warpMode 是启动时读环境变量的（const），
    //  运行期改不了，这里明确回 501 而不是假装成功。
    //  proxyRefreshMs 可以落盘，保存到 data/runtime_config.json。
    // ───────────────────────────────────────────────
    if (pathname === '/api/config' && method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const applied: string[] = [];
      const ignored: string[] = [];

      // 可运行时生效的
      if (typeof body.proxyRefreshMs === 'number' && body.proxyRefreshMs > 0) {
        runtimeConfig.proxyRefreshMs = body.proxyRefreshMs;
        applied.push('proxyRefreshMs');
      }

      // 需要重启 / 改环境变量的
      for (const k of ['port', 'maxActiveKeys', 'slotCount', 'warpMode', 'fallbackProxy']) {
        if (body[k] !== undefined) ignored.push(k);
      }

      saveRuntimeConfig();
      json(res, 200, {
        success: true,
        applied,
        ignored,
        message: applied.length
          ? `已保存: ${applied.join(', ')}`
          : '没有可运行时修改的项',
        hint: ignored.length
          ? `${ignored.join(', ')} 是启动时读取的环境变量，修改需要改 compose/.env 后重建容器：PORT / MAX_ACTIVE_KEYS / SINGBOX_MODE / FALLBACK_PROXY`
          : '',
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/logs
    // ───────────────────────────────────────────────
    if (pathname === '/api/logs' && method === 'GET') {
      json(res, 200, { logs: recentLogs.slice(-200) });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/audit
    // ───────────────────────────────────────────────
    if (pathname === '/api/audit' && method === 'GET') {
      // 面板 fetchAudit() 读 s.summary 和 s.days，这里一并算出来，
      // 否则审计页永远是空的（只有 audit 原始数组没人用）。
      const entries = auditLog;
      let totalRequests = 0, totalTokens = 0, totalPrompt = 0, totalCompletion = 0, cacheRead = 0;
      const byDay: Record<string, { requests: number; totalTokens: number; promptTokens: number; completionTokens: number; cacheRead: number }> = {};
      for (const e of entries) {
        totalRequests++;
        totalTokens += e.totalTokens || 0;
        totalPrompt += e.promptTokens || 0;
        totalCompletion += e.completionTokens || 0;
        cacheRead += e.cacheRead || 0;
        const d = new Date(e.ts);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const b = byDay[key] || (byDay[key] = { requests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cacheRead: 0 });
        b.requests++;
        b.totalTokens += e.totalTokens || 0;
        b.promptTokens += e.promptTokens || 0;
        b.completionTokens += e.completionTokens || 0;
        b.cacheRead += e.cacheRead || 0;
      }
      const days = Object.keys(byDay).sort().reverse().map((date) => ({ date, ...byDay[date] }));
      json(res, 200, {
        audit: entries.slice(-500),
        summary: {
          totalRequests, totalTokens, totalPrompt, totalCompletion,
          cacheHitRate: totalPrompt > 0 ? cacheRead / totalPrompt : 0,
        },
        days,
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/keys
    // ───────────────────────────────────────────────
    if (pathname === '/api/keys' && method === 'GET') {
      // 面板 fetchKeys() 期望 keys 是数组并用 x.fullKey 取全量 key，
      // 这里同时给出数组（records）和原始对象（map），
      // 免得改前端。数组元素补 fullKey 字段。
      const records = Object.values(apiKeys).map((k: any) => ({ ...k, fullKey: k.key }));
      json(res, 200, { keys: records, records, map: apiKeys, total: records.length });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/keys  — 创建 key
    // ───────────────────────────────────────────────
    if (pathname === '/api/keys' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const key = body.key || 'sk-' + crypto.randomBytes(16).toString('hex');
      apiKeys[key] = {
        key, name: body.name || 'unnamed', enabled: true,
        createdAt: Date.now(), lastUsedAt: 0,
        totalRequests: 0, totalTokens: 0,
        maxConcurrency: body.maxConcurrency || 5,
        maxRequests: body.maxRequests || 1000000,
        requestCount: 0, expiresAt: body.expiresAt || Date.now() + 365 * 86400000,
      };
      saveKeys();
      json(res, 200, { success: true, key });
      return;
    }

    // ───────────────────────────────────────────────
    //  DELETE /api/keys/:key
    // ───────────────────────────────────────────────
    if (pathname.startsWith('/api/keys/') && method === 'DELETE') {
      const key = pathname.slice('/api/keys/'.length);
      if (apiKeys[key]) { delete apiKeys[key]; saveKeys(); json(res, 200, { success: true }); }
      else json(res, 404, { error: 'key 不存在' });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/models
    // ───────────────────────────────────────────────
    if (pathname === '/api/models' && method === 'GET') {
      // 面板 fetchModels() 读 s.models，这里同时给出 models 别名
      json(res, 200, { data: cachedModels, models: cachedModels, cachedAt: cachedModelsTime, count: cachedModels.length });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/models/refresh  — 刷新模型列表
    // ───────────────────────────────────────────────
    if (pathname === '/api/models/refresh' && method === 'POST') {
      const models = await fetchModelsFromUpstream();
      json(res, 200, { success: true, count: models.length });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/subscription  — 添加订阅
    // ───────────────────────────────────────────────
    if (pathname === '/api/subscription' && method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (!body.url) { json(res, 400, { error: 'url 必填' }); return; }
      const sub: SubscriptionConfig = { url: body.url, token: body.token || '', updatedAt: Date.now() };
      try {
        const count = await generateSingboxConfig(sub);
        saveSubscription(sub);
        await reloadSingboxConfig();
        json(res, 200, { success: true, nodes: count, message: `已解析 ${count} 个节点，sing-box 已重载` });
      } catch (e: any) {
        json(res, 500, { error: `生成配置失败: ${e.message}` });
      }
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/subscription  — 查看订阅状态
    // ───────────────────────────────────────────────
    if (pathname === '/api/subscription' && method === 'GET') {
      const sub = loadSubscription();
      json(res, 200, {
        subscription: sub,
        nodes: singboxNodes,
        currentNode: singboxNodes[singboxNodeIndex] || '',
        nodeIndex: singboxNodeIndex,
        singboxOk,
        configFile: fs.existsSync(path.join(SINGBOX_CONFIG_DIR, 'singbox_config.json')),
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/singbox/switch  — 手动切换节点
    // ───────────────────────────────────────────────
    if (pathname === '/api/singbox/switch' && method === 'POST') {
      const node = await switchSingboxNode();
      if (node) json(res, 200, { success: true, node });
      else json(res, 500, { error: '切换失败' });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/singbox/check  — 检查 sing-box 健康
    // ───────────────────────────────────────────────
    if (pathname === '/api/singbox/check' && method === 'POST') {
      const ok = await checkSingboxHealth();
      json(res, 200, { ok, nodes: singboxNodes.length, currentNode: singboxNodes[singboxNodeIndex] || '' });
      return;
    }

    // ───────────────────────────────────────────────
    //  POST /api/singbox/reload  — 重载 sing-box 配置
    // ───────────────────────────────────────────────
    if (pathname === '/api/singbox/reload' && method === 'POST') {
      const ok = await reloadSingboxConfig();
      json(res, 200, { success: ok });
      return;
    }

    // ───────────────────────────────────────────────
    //  GET /api/stats  — 详细统计
    // ───────────────────────────────────────────────
    if (pathname === '/api/stats' && method === 'GET') {
      json(res, 200, {
        stats,
        uptime: Date.now() - START_TIME,
        activeRequests: Object.entries(activeRequests).map(([k, v]) => ({ key: k, count: v })),
        singbox: { ok: singboxOk, nodes: singboxNodes.length },
      });
      return;
    }

    // ───────────────────────────────────────────────
    //  v1/chat/completions  — 非流式
    // ───────────────────────────────────────────────
    if (pathname === '/v1/chat/completions' && (method === 'POST' || method === 'OPTIONS')) {
      if (method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'access-control-allow-headers': '*' }); res.end(); return; }
      const body = await readBody(req);
      const auth = req.headers['authorization'] || '';
      const key = auth.replace(/^Bearer\s+/i, '').trim();
      const v = validateKey(key);
      if (!v.valid) { json(res, 401, { error: { message: v.reason } }); return; }
      acquireKey(key);
      try {
        const parsed = JSON.parse(body);
        const isStream = !!parsed.stream;
        recordKeyUsage(key, 0);
        if (isStream) {
          const result = await dispatchStream(pathname, method, collectHeadersFromReq(req), body, key);
          res.writeHead(result.status, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            ...result.headers,
          });
          const reader = result.stream.getReader();
          const pump = async () => {
            try { while (true) { const { done, value } = await reader.read(); if (done) { res.end(); return; } res.write(value); } }
            catch { res.end(); }
          };
          pump();
        } else {
          const result = await dispatchNonStream(pathname, method, collectHeadersFromReq(req), body, key);
          const usage = extractUsageFromResponse(result.body);
          if (usage.tokens > 0) recordKeyUsage(key, usage.tokens);
          res.writeHead(result.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
          res.end(result.body);
        }
      } catch (e: any) {
        json(res, 400, { error: { message: `请求解析失败: ${e.message}` } });
      } finally {
        releaseKey(key);
      }
      return;
    }

    // ───────────────────────────────────────────────
    //  v1/* 其他端点 — 代理到上游
    // ───────────────────────────────────────────────
    if (pathname.startsWith('/v1/')) {
      const auth = req.headers['authorization'] || '';
      const key = auth.replace(/^Bearer\s+/i, '').trim();
      const v = validateKey(key);
      if (!v.valid) { json(res, 401, { error: { message: v.reason } }); return; }
      acquireKey(key);
      try {
        const body = method === 'GET' || method === 'DELETE' ? undefined : await readBody(req);
        const result = await dispatchNonStream(pathname, method, collectHeadersFromReq(req), body || '', key);
        // /v1/models 只保留 free 模型（兼容旧行为，big-pickle 是隐身免费模型）
        if (pathname === '/v1/models' && result.status === 200 && result.body) {
          try {
            const parsed = JSON.parse(result.body);
            const all = parsed.data || parsed.models || [];
            const freeModels = all.filter((m: any) => {
              const id = String(m.id || '');
              return id.endsWith('-free') || id === 'big-pickle';
            });
            parsed.data = freeModels;
            parsed.models = freeModels;
            res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
            res.end(JSON.stringify(parsed));
            return;
          } catch {}
        }
        res.writeHead(result.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
        res.end(result.body);
      } catch (e: any) {
        json(res, 500, { error: { message: e.message } });
      } finally {
        releaseKey(key);
      }
      return;
    }

    // ───────────────────────────────────────────────
    //  静态文件服务 — public/ 目录（管理面板资源）
    // ───────────────────────────────────────────────
    if (method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/v1/') && pathname !== '/status' && pathname !== '/ping') {
      if (serveStatic(res, pathname)) return;

      // SPA fallback：非 API 路径找不到文件时回退 index.html
      //
      // 但带扩展名的请求（.js/.css/.png…）必须老实返 404。
      // 否则缺失的静态资源会拿到 index.html + HTTP 200，
      // 浏览器把 text/html 当 JS 执行 → 静默失败、面板永远"加载中"，
      // 而且 CDN / 浏览器会把这些假 200 缓存起来掩盖真实错误。
      const ext = path.extname(pathname).toLowerCase();
      const looksLikeAsset = ext !== '' && ext in MIME_TYPES;
      if (!looksLikeAsset) {
        const idxPath = PUBLIC_DIR + '/index.html';
        if (fs.existsSync(idxPath)) {
          const data = fs.readFileSync(idxPath);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
          res.end(data);
          return;
        }
      }
    }

    // ───────────────────────────────────────────────
    //  404
    // ───────────────────────────────────────────────
    json(res, 404, { error: { message: 'not found' } });

  } catch (e: any) {
    if (e instanceof BodyTooLargeError) {
      // 响应写完再断连接：body 没收完时保持连接会占着 socket 和内存。
      res.on('finish', () => { try { req.destroy(); } catch {} });
      json(res, 413, { error: { message: e.message } });
      return;
    }
    console.error(`[handler] ${e.message}`);
    json(res, 500, { error: { message: e.message } });
  }
}

// ═══════════════════════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════════════════════

const server = http.createServer(handler);

// 超时收紧。Node 默认 requestsTimeout=300s / headersTimeout=60s，
// 对一个反代网关来说太宽松：慢速攻击（Slowloris）能靠一堆半开连接
// 把并发槽位占满。这里给网关级合理值。
// 注意 requestsTimeout 必须 > headersTimeout。
server.headersTimeout = 20_000;
server.requestTimeout = 120_000;   // 单请求含 body 上传，超过直接断
server.keepAliveTimeout = 15_000;
server.maxHeadersCount = 100;

// 限制同时打开的上游连接数，防止单实例被打爆
server.maxConnections = parseInt(process.env.MAX_CONNECTIONS || '2048');

// /ping 已在 handler 内部处理；不要再注册第二个 'request' 监听器，
// 否则响应写完后再次 writeHead 会抛 ERR_HTTP_HEADERS_SENT 使进程崩溃。

// 未捕获异常不要静默退出，记录后继续跑；只有 listen 阶段的错误才致命
process.on('uncaughtException', (e: any) => {
  console.error(`[fatal] uncaughtException: ${e?.message}\n${e?.stack || ''}`);
});
process.on('unhandledRejection', (r: any) => {
  console.error(`[fatal] unhandledRejection: ${r?.message || r}`);
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n[opencode-gate] SingBox 版启动`);
  console.log(`[opencode-gate] 端口: ${PORT}`);
  console.log(`[opencode-gate] 上游: ${UPSTREAM}`);
  console.log(`[opencode-gate] SingBox: ${SINGBOX_MODE === 'on' ? `Socks5 ${SINGBOX_SOCKS_URL} / API ${SINGBOX_API_URL}` : '关闭'}`);
  console.log(`[opencode-gate] 数据目录: ${DATA_DIR}`);
  // 不打印 API_KEY 明文 —— 日志会进 docker logs / 日志文件，可能被人捡到。
  // 原来这行是 `API Key: ${API_KEY}`，属于凭据泄漏。
  console.log(`[opencode-gate] 鉴权: /v1/* 用 keys.json 里的 key；/api/* ${ADMIN_TOKEN ? '已启用 ADMIN_TOKEN 保护' : '未配置 ADMIN_TOKEN —— 公网部署请务必配置'}\n`);

  // 加载持久化数据
  loadKeys();
  loadAuditLog();
  if (!loadModelsCache()) await fetchModelsFromUpstream();

  // 初始化 sing-box
  if (SINGBOX_MODE === 'on') {
    loadSingboxNodes();
    const ok = await checkSingboxHealth();
    console.log(`[SingBox] 健康检查: ${ok ? '✅ 正常' : '❌ 离线'}`);
    if (ok) {
      loadSingboxNodes();
      await initSingboxNode();
      if (singboxOk) {
        console.log(`[SingBox] 当前节点: ${singboxNodes[singboxNodeIndex]}`);
      }
    }
  }

  // 定期刷新模型
  setInterval(() => fetchModelsFromUpstream(), 60000);
  // 定期检查 sing-box 健康
  if (SINGBOX_MODE === 'on') {
    setInterval(() => checkSingboxHealth(), 30000);
  }
});

// 优雅关闭
function shutdown(signal: string) {
  console.log(`收到 ${signal}，关闭中...`);
  // 退出前把节流中的 key 用量落盘，避免丢掉最后几个请求的计数
  if (keyDirty) { keyDirty = false; saveKeys(); }
  server.close();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => { if (keyDirty) { keyDirty = false; try { saveKeys(); } catch {} } });
