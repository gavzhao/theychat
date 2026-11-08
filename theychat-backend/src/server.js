// theychat 服务端：路由与入口（设计见 DESIGN.md §6）
// 本服务没有任何认证：任何能碰到端口的人都能读写一切频道——只该部署在可信网络。
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { createStore } from './db.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { extname, resolve as resolvePath, sep } from 'node:path';
import { createBlobStore, newFileId, guessMime } from './files.js';
import {
  HttpError, parseJson, assertName, assertInt, assertFrom, validateMessageBody,
  assertFileName, assertCaption, FILE_CONTENT_TYPE, CLIENT_ID_RE,
} from './schemas.js';

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://theychat:theychat@localhost:5432/theychat';
const port = Number(process.env.THEYCHAT_PORT ?? 8000);
const host = process.env.THEYCHAT_HOST ?? '0.0.0.0';

// 文件交换（DESIGN §12）：配置了 THEYCHAT_S3_ENDPOINT 时 blob 存 S3 兼容对象存储，否则存本地目录；
// 本地目录同时承载上传中的临时文件
const filesDir = process.env.THEYCHAT_FILES_DIR ?? './data/files';
const s3 = {
  endpoint: process.env.THEYCHAT_S3_ENDPOINT,
  accessKey: process.env.THEYCHAT_S3_ACCESS_KEY,
  secretKey: process.env.THEYCHAT_S3_SECRET_KEY,
  bucket: process.env.THEYCHAT_S3_BUCKET ?? 'theychat-files',
};
const maxFileBytes = Number(process.env.THEYCHAT_MAX_FILE_BYTES ?? 25 * 1024 * 1024);
const filesQuotaBytes = Number(process.env.THEYCHAT_FILES_QUOTA_BYTES ?? 2 * 1024 * 1024 * 1024);
// 接收即删除（DESIGN §12 生命周期）：全部收件人确认收到即删；兜底保留期过后无论如何删除
const fileTtlSeconds = Number(process.env.THEYCHAT_FILE_TTL_HOURS ?? 24) * 3600;
const fileGcSeconds = Number(process.env.THEYCHAT_FILE_GC_SECONDS ?? 600);

const store = await createStore(databaseUrl);
const blobs = await createBlobStore({ dir: filesDir, s3 });
// 孤儿回收：清空 tmp/，删除没有 files 行引用的 blob（上传顺序是「先转正再提交事务、事务失败即删」，
// 崩溃最多留下无引用 blob，由这里兜底）
const swept = await blobs.sweep((id) => store.hasFileId(id));
if (swept) console.log(`files: swept ${swept} orphan blob(s)`);

async function expireFiles() {
  const ids = await store.expireFiles(Date.now() / 1000 - fileTtlSeconds);
  for (const id of ids) await blobs.remove(id).catch((e) => console.error(`files: failed to remove ${id}:`, e.message));
  if (ids.length) console.log(`files: expired ${ids.length} file(s)`);
}
setInterval(() => expireFiles().catch((e) => console.error('file expiry failed:', e)), fileGcSeconds * 1000).unref();
await expireFiles();

const app = new Hono();

app.use(logger());
app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status);
  }
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
});
app.notFound((c) =>
  c.json({ error: { code: 'not_found', message: 'route not found' } }, 404)
);

app.get('/healthz', (c) => c.json({ ok: true }));

const v1 = new Hono();

// ---------- client_id 中间件（DESIGN §3：游标归属的透明标签） ----------
//
// 需要 X-Client-Id 的端点：GET messages、POST ack、GET cursor、POST files、POST files/:id/received。
// 缺头 → 400 missing_client_id；格式非法（1-64 字符 [A-Za-z0-9._-]）→ 400 invalid_client_id。
// 服务端不建档、不验证、不存哈希。
const requireClientId = async (c, next) => {
  const raw = c.req.header('x-client-id');
  if (!raw) {
    throw new HttpError(400, 'missing_client_id', 'missing X-Client-Id header (generate one random id locally and reuse it)');
  }
  if (!CLIENT_ID_RE.test(raw)) {
    throw new HttpError(400, 'invalid_client_id', `X-Client-Id must match ${CLIENT_ID_RE} (1-64 chars of [A-Za-z0-9._-])`);
  }
  c.set('clientId', raw);
  await next();
};

const cid = new Hono();
cid.use('*', requireClientId);

// ---------- 公开路由 ----------

// GET /v1/info —— 服务端实例信息（§13）：instance_id 稳定不变，客户端据此合并指向同一服务端的不同 URL
v1.get('/info', (c) => c.json({
  instance_id: store.instanceId,
  max_file_bytes: maxFileBytes,
  file_ttl_seconds: fileTtlSeconds,
}));

// 频道必须已显式创建，否则 404，不隐式创建（§6.3）
async function requireChannel(c) {
  const ch = c.req.param('ch');
  if (!await store.hasChannel(ch)) {
    throw new HttpError(404, 'channel_not_found', `channel "${ch}" does not exist`);
  }
  return ch;
}

// POST /v1/channels —— 创建频道（§6.2）；created_by 记录创建时自报的 from（可空）
v1.post('/channels', async (c) => {
  const body = await parseJson(c);
  const name = assertName(body?.name, 'name');
  const createdBy = body?.from === undefined || body?.from === null ? null : assertFrom(body.from);
  const ch = await store.createChannel(name, createdBy);
  return c.json({ name: ch.name, created_at: ch.created_at, created_by: ch.created_by }, 201);
});

// GET /v1/channels —— 频道列表；X-Client-Id 可选（带头附自己视角的游标 / 积压，§6.7）
v1.get('/channels', async (c) => {
  const raw = c.req.header('x-client-id');
  let clientId = null;
  if (raw) {
    if (!CLIENT_ID_RE.test(raw)) {
      throw new HttpError(400, 'invalid_client_id', `X-Client-Id must match ${CLIENT_ID_RE} (1-64 chars of [A-Za-z0-9._-])`);
    }
    clientId = raw;
  }
  return c.json({ channels: await store.listChannels(clientId) });
});

// POST /v1/channels/:ch/messages —— 发布消息（§6.3）；sender = 自报的 from（缺省 "anon"）
v1.post('/channels/:ch/messages', async (c) => {
  const ch = await requireChannel(c);
  const raw = await parseJson(c);
  const body = validateMessageBody(raw);
  const from = assertFrom(raw.from);
  if (body.reply_to !== undefined && !await store.hasMessage(ch, body.reply_to)) {
    throw new HttpError(
      422, 'reply_target_missing',
      `reply_to seq ${body.reply_to} not found in channel "${ch}"`
    );
  }
  const msg = await store.insertMessage({ channel: ch, sender: from, ...body });
  return c.json({
    channel: ch,
    seq: msg.seq,
    sender: from,
    content: body.content,
    content_type: body.content_type,
    reply_to: body.reply_to ?? null,
    created_at: msg.created_at,
  }, 201);
});

// GET /v1/channels/:ch/messages —— 拉取消息，支持长轮询（§6.4）
cid.get('/channels/:ch/messages', async (c) => {
  const ch = await requireChannel(c);
  const clientId = c.get('clientId');
  const q = c.req.query();

  // since 显式传入 = 临时覆盖，仅本次生效、不动游标（§4.5）；
  // 不传 = 用服务端游标，首次拉取按 §5 初始化（最近 10 分钟）。
  let base;
  let initialized = false;
  if (q.since !== undefined) {
    base = assertInt(q.since, { min: 0, label: 'since' });
  } else {
    ({ cursor: base, initialized } = await store.ensureCursor(ch, clientId));
  }

  const wait = assertInt(q.wait ?? 0, { min: 0, max: 60, label: 'wait' });
  const limit = assertInt(q.limit ?? 100, { min: 1, max: 1000, label: 'limit' });

  let messages = await store.messagesSince(ch, base, limit);
  const deadline = Date.now() + wait * 1000;
  while (messages.length === 0 && Date.now() < deadline) {
    await store.waitForMessage(ch, deadline - Date.now());
    messages = await store.messagesSince(ch, base, limit);
  }

  return c.json({
    channel: ch,
    messages,
    cursor: base,
    cursor_initialized: initialized,
    latest_seq: await store.latestSeq(ch),
  });
});

// POST /v1/channels/:ch/ack —— 推进游标水位线（§6.5）
cid.post('/channels/:ch/ack', async (c) => {
  const ch = await requireChannel(c);
  const body = await parseJson(c);
  const through = assertInt(body?.through, { min: 0, label: 'through' });
  const cursor = await store.setCursor(ch, c.get('clientId'), through);
  return c.json({ channel: ch, cursor });
});

// GET /v1/channels/:ch/cursor —— 查看游标（§6.6）
cid.get('/channels/:ch/cursor', async (c) => {
  const ch = await requireChannel(c);
  const clientId = c.get('clientId');
  const row = await store.getCursorRow(ch, clientId);
  return c.json({
    channel: ch,
    client_id: clientId,
    cursor: row ? row.cursor : null,
    updated_at: row ? row.updated_at : null,
  });
});

// GET /v1/channels/:ch/members —— 频道成员列表（§3：成员 = 持游标者）：公开只读信息，无需 X-Client-Id
v1.get('/channels/:ch/members', async (c) => {
  const ch = await requireChannel(c);
  const members = await store.listMembers(ch);
  return c.json({ channel: ch, count: members.length, members });
});

// POST /v1/channels/:ch/files —— 上传文件（§12）：body 为原始字节流，落盘后作为一条文件消息进入频道日志
cid.post('/channels/:ch/files', async (c) => {
  const ch = await requireChannel(c);
  const clientId = c.get('clientId');
  const q = c.req.query();
  const name = assertFileName(q.name);
  const caption = assertCaption(q.caption);
  const from = assertFrom(q.from);
  let reply_to;
  if (q.reply_to !== undefined && q.reply_to !== '') {
    reply_to = assertInt(q.reply_to, { min: 1, label: 'reply_to' });
    if (!await store.hasMessage(ch, reply_to)) {
      throw new HttpError(422, 'reply_target_missing', `reply_to seq ${reply_to} not found in channel "${ch}"`);
    }
  }

  // 声明了 Content-Length 的先行拦截，免得白传一遍
  const declared = Number(c.req.header('content-length') ?? NaN);
  if (declared > maxFileBytes) {
    throw new HttpError(413, 'file_too_large', `file exceeds ${maxFileBytes} bytes`);
  }
  const assertQuota = async (size) => {
    if (await store.filesTotalBytes() + size > filesQuotaBytes) {
      throw new HttpError(507, 'storage_quota_exceeded', 'server file storage quota exceeded');
    }
  };
  if (declared > 0) await assertQuota(declared);

  const blob = await blobs.receive(c.req.raw.body, maxFileBytes);
  try {
    if (blob.size === 0) throw new HttpError(422, 'empty_file', 'file is empty');
    await assertQuota(blob.size);
  } catch (e) {
    blobs.discard(blob.tmpPath);
    throw e;
  }
  const fileId = newFileId();
  const mime = guessMime(name, c.req.header('content-type'));
  await blobs.commit(blob.tmpPath, fileId, { size: blob.size, mime });

  let msg;
  try {
    msg = await store.insertFile({
      fileId, channel: ch, clientId, from, name, size: blob.size, sha256: blob.sha256,
      mime, caption, reply_to,
    });
  } catch (e) {
    await blobs.remove(fileId).catch(() => {}); // 事务失败即删，崩溃残留由启动 sweep 兜底
    throw e;
  }
  return c.json({
    channel: ch,
    seq: msg.seq,
    sender: from,
    content: msg.content,
    content_type: FILE_CONTENT_TYPE,
    reply_to: reply_to ?? null,
    created_at: msg.created_at,
    file: JSON.parse(msg.content),
  }, 201);
});

// GET /v1/channels/:ch/files/:id —— 下载文件（§12）
v1.get('/channels/:ch/files/:id', async (c) => {
  const ch = await requireChannel(c);
  return serveFile(ch, c.req.param('id'));
});

// POST /v1/channels/:ch/files/:id/received —— 收件确认（§12 生命周期）：客户端校验 sha256 后调用；全部收件人确认即删除
cid.post('/channels/:ch/files/:id/received', async (c) => {
  const ch = await requireChannel(c);
  const id = c.req.param('id');
  const row = await store.getFile(ch, id);
  if (!row) throw new HttpError(404, 'file_not_found', `file "${id}" not found in channel "${ch}"`);
  const r = await store.confirmFileReceived(id, c.get('clientId'));
  if (r.deleted) await blobs.remove(id).catch((e) => console.error(`files: failed to remove ${id}:`, e.message));
  return c.json({ file_id: id, deleted: r.deleted || !!r.already_deleted, remaining_recipients: r.remaining });
});

/** 文件下载响应 */
async function serveFile(ch, id) {
  const row = await store.getFile(ch, id);
  if (!row) throw new HttpError(404, 'file_not_found', `file "${id}" not found in channel "${ch}"`);
  if (row.deleted_at) {
    throw new HttpError(410, 'file_deleted', row.deleted_reason === 'expired'
      ? `file "${row.name}" expired and was deleted from the server (files are kept at most ${fileTtlSeconds / 3600} h)`
      : `file "${row.name}" was deleted from the server after every recipient received it (files are not kept once delivered)`);
  }
  const stream = await blobs.open(id);
  if (!stream) throw new HttpError(410, 'file_gone', `file "${id}" is missing from server storage`);
  const encoded = encodeURIComponent(row.name);
  return new Response(Readable.toWeb(stream), {
    headers: {
      'content-type': row.mime,
      'content-length': String(row.size),
      'content-disposition': `attachment; filename*=UTF-8''${encoded}`,
      // sha256 / 文件名以响应头下发（供人工排查；CLI 校验用消息元数据里的 sha256）
      'x-theychat-file-name': encoded,
      'x-theychat-sha256': row.sha256,
      'x-content-type-options': 'nosniff',
    },
  });
}

v1.route('/', cid);
app.route('/v1', v1);

// ---------- Web 前台（DESIGN 之外的增量）：托管 theychat-web/dist 的 vite 静态产物 ----------
// 身份模型与 CLI 一致：浏览器 localStorage 里的 client_id（X-Client-Id 头）+ 自报 from。
// 必须注册在 /v1 路由之后：catch-all 只接住 API/健康检查之外的路径。
const WEB_DIST = fileURLToPath(new URL('../../theychat-web/dist/', import.meta.url));
if (!existsSync(WEB_DIST)) {
  console.warn(`web: dist not found at ${WEB_DIST} — run \`npm run build -w theychat-web\` first, non-API GETs will 404`);
}
const WEB_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const webNotFound = (c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);

app.get('*', async (c) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(c.req.url).pathname);
  } catch {
    return webNotFound(c);
  }
  // 目录穿越防护：显式拒绝 .. 与 NUL，再以 resolve + 前缀校验兜底（Windows/POSIX 语义都覆盖）
  if (pathname.includes('..') || pathname.includes('\0')) return webNotFound(c);
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const root = WEB_DIST.endsWith(sep) ? WEB_DIST : WEB_DIST + sep;
  const filePath = resolvePath(WEB_DIST, rel);
  if (!filePath.startsWith(root)) return webNotFound(c);
  let buf;
  try {
    buf = await readFile(filePath);
  } catch {
    return webNotFound(c); // 未命中（SPA 走 hash 路由，无需 fallback 到 index.html）
  }
  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'   // vite 指纹资源：内容不变，可永久缓存
    : rel === 'index.html'
      ? 'no-cache'
      : 'public, max-age=3600';
  return c.body(buf, 200, {
    'content-type': WEB_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': cacheControl,
  });
});

// ---------- 启动 ----------

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`theychat-backend listening on http://${info.address}:${info.port}`);
  console.log(`  db: ${databaseUrl.replace(/\/\/[^@/]*@/, '//***@')}`);
  console.log(`  files: ${blobs.kind} (max ${maxFileBytes} B/file, quota ${filesQuotaBytes} B)`);
  console.log('  no auth: anyone who can reach this port can read and write every channel — deploy on a trusted network only');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
