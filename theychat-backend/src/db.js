// Postgres 访问层：版本化建表、seq 分配、游标语义、文件元数据
// 设计见 DESIGN.md §3（身份退化：client_id + 自报 from）/§4（可靠投递）/§5（游标初始化）/§8（存储）
import pg from 'pg';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { HttpError, FILE_CONTENT_TYPE } from './schemas.js';

/** 游标初始化窗口：新订阅者可见最近 10 分钟内的消息（DESIGN §5） */
const CURSOR_INIT_WINDOW_SECONDS = 600;

/**
 * 版本化迁移：按顺序执行，已执行的版本记录在 schema_migrations。
 * 只追加不修改——改表结构就加一个新版本。
 *
 * v1：theychat 全部表。没有账号 / 名册 / 密码：频道成员 = 在该频道有游标（cursors 有行）的 client_id。
 */
export const MIGRATIONS = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE channels (
    name       TEXT PRIMARY KEY,
    created_by TEXT,
    last_seq   INTEGER NOT NULL DEFAULT 0,
    created_at DOUBLE PRECISION NOT NULL
  );

  CREATE TABLE messages (
    channel      TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    sender       TEXT NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content      TEXT NOT NULL,
    reply_to     INTEGER,
    created_at   DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (channel, seq)
  );

  CREATE TABLE files (
    id         TEXT PRIMARY KEY,
    channel    TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    client_id  TEXT NOT NULL,
    "from"     TEXT,
    name       TEXT NOT NULL,
    size       BIGINT NOT NULL,
    sha256     TEXT NOT NULL,
    mime       TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL,
    deleted_at DOUBLE PRECISION,
    deleted_reason TEXT
  );
  CREATE INDEX idx_files_channel ON files(channel);

  CREATE TABLE file_recipients (
    file_id     TEXT NOT NULL,
    client_id   TEXT NOT NULL,
    received_at DOUBLE PRECISION,
    PRIMARY KEY (file_id, client_id)
  );

  CREATE TABLE cursors (
    channel    TEXT NOT NULL,
    client_id  TEXT NOT NULL,
    cursor     INTEGER NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (channel, client_id)
  );
  `,
];

/** upTo：只迁移到指定版本 */
export async function migrate(pool, upTo = MIGRATIONS.length) {
  const client = await pool.connect();
  try {
    // 多实例同时启动时用咨询锁串行化迁移
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())'
    );
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    for (let v = rows[0].v + 1; v <= upTo; v++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v - 1]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}

export async function createStore(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  await migrate(pool);

  const now = () => Date.now() / 1000;
  const q = (text, params) => pool.query(text, params);
  const one = async (text, params, client = pool) => (await client.query(text, params)).rows[0];

  /** 事务：fn 收到专用 client，抛错即回滚 */
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // 新消息事件：长轮询在本进程内被即时唤醒（多实例部署时退化为定时重查）
  const events = new EventEmitter();
  events.setMaxListeners(0);

  // 实例 id：首次启动生成并持久化，让客户端识别「多个 URL 指向同一服务端」（DESIGN §13）
  await q('INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
    ['instance_id', 'srv_' + randomBytes(9).toString('base64url')]);
  const instanceId = (await one("SELECT value FROM meta WHERE key = 'instance_id'")).value;

  // ---- channels ----

  async function hasChannel(name) {
    return !!(await one('SELECT 1 FROM channels WHERE name = $1', [name]));
  }

  async function getChannelRow(name) {
    return one('SELECT name, created_by, created_at FROM channels WHERE name = $1', [name]);
  }

  async function createChannel(name, createdBy) {
    const ts = now();
    const r = await q(
      `INSERT INTO channels (name, created_by, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [name, createdBy ?? null, ts]
    );
    if (!r.rowCount) {
      throw new HttpError(409, 'channel_exists', `channel "${name}" already exists`);
    }
    return { name, created_by: createdBy ?? null, created_at: ts };
  }

  async function listChannels(clientId) {
    const { rows } = clientId
      ? await q(`
          SELECT c.name, c.created_at, c.created_by, c.last_seq AS latest_seq, cu.cursor AS my_cursor
          FROM channels c
          LEFT JOIN cursors cu ON cu.channel = c.name AND cu.client_id = $1
          ORDER BY c.created_at
        `, [clientId])
      : await q(`
          SELECT c.name, c.created_at, c.created_by, c.last_seq AS latest_seq
          FROM channels c
          ORDER BY c.created_at
        `);
    return rows.map((r) => {
      const latest = r.latest_seq ?? 0;
      const ch = {
        name: r.name,
        created_at: r.created_at,
        created_by: r.created_by,
        latest_seq: latest,
      };
      if (clientId) {
        ch.my_cursor = r.my_cursor ?? null;
        ch.pending = r.my_cursor == null ? null : Math.max(0, latest - r.my_cursor);
      }
      return ch;
    });
  }

  // ---- messages ----

  async function latestSeq(channel) {
    return (await one('SELECT last_seq FROM channels WHERE name = $1', [channel]))?.last_seq ?? 0;
  }

  async function hasMessage(channel, seq) {
    return !!(await one('SELECT 1 FROM messages WHERE channel = $1 AND seq = $2', [channel, seq]));
  }

  /**
   * seq 分配（DESIGN §8）：UPDATE ... RETURNING 对频道行加行锁直到提交，
   * 同频道并发写入被串行化，保证 seq 严格单调无空洞。
   */
  async function insertTx(client, { channel, sender, content, content_type, reply_to }) {
    const { rows } = await client.query(
      'UPDATE channels SET last_seq = last_seq + 1 WHERE name = $1 RETURNING last_seq', [channel]
    );
    if (!rows.length) throw new HttpError(404, 'channel_not_found', `channel "${channel}" does not exist`);
    const seq = rows[0].last_seq;
    const created_at = now();
    await client.query(`
      INSERT INTO messages (channel, seq, sender, content_type, content, reply_to, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [channel, seq, sender, content_type, content, reply_to ?? null, created_at]);
    return { seq, created_at };
  }

  async function insertMessage(msg) {
    const r = await tx((client) => insertTx(client, msg));
    events.emit('message', msg.channel);
    return r;
  }

  async function messagesSince(channel, since, limit) {
    const { rows } = await q(`
      SELECT m.seq, m.sender, m.content_type, m.content, m.reply_to, m.created_at
      FROM messages m
      WHERE m.channel = $1 AND m.seq > $2
      ORDER BY m.seq
      LIMIT $3
    `, [channel, since, limit]);
    return rows;
  }

  /**
   * 等待频道出现新消息，最多 ms 毫秒：本进程写入即时唤醒，
   * 另以 2s 间隔兜底（多实例部署时别的进程写入的消息靠它发现）。
   */
  function waitForMessage(channel, ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        events.off('message', onMsg);
        resolve();
      };
      const onMsg = (ch) => { if (ch === channel) done(); };
      const timer = setTimeout(done, Math.min(ms, 2000));
      events.on('message', onMsg);
    });
  }

  // ---- files（DESIGN §12：文件即消息，files 行与文件消息同一事务写入）----

  /** 写 files 行 + 对应的文件消息；content 为元数据 JSON（字段顺序固定，便于客户端展示） */
  async function insertFile({ fileId, channel, clientId, from, name, size, sha256, mime, caption, reply_to }) {
    const content = JSON.stringify({
      file_id: fileId, name, size, sha256, mime, caption: caption ?? null, from: from ?? null,
    });
    const msg = await tx(async (client) => {
      const m = await insertTx(client, { channel, sender: from ?? '', content, content_type: FILE_CONTENT_TYPE, reply_to });
      await client.query(`
        INSERT INTO files (id, channel, seq, client_id, "from", name, size, sha256, mime, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [fileId, channel, m.seq, clientId, from ?? null, name, size, sha256, mime, m.created_at]);
      // 收件人 = 上传这一刻在该频道有游标的全部 client_id（频道成员定义，DESIGN §3），除上传者自己；
      // 全部确认收到即删除 blob
      await client.query(`
        INSERT INTO file_recipients (file_id, client_id)
        SELECT $1, client_id FROM cursors WHERE channel = $2 AND client_id != $3
      `, [fileId, channel, clientId]);
      return m;
    });
    events.emit('message', channel);
    return { ...msg, content };
  }

  async function getFile(channel, fileId) {
    const row = await one(
      `SELECT id, channel, seq, client_id, "from" AS sender, name, size, sha256, mime, created_at, deleted_at, deleted_reason
       FROM files WHERE channel = $1 AND id = $2`,
      [channel, fileId]
    );
    return row ? { ...row, size: Number(row.size) } : undefined;
  }

  /** blob 仍应存在（有 files 行且未删除）——孤儿回收据此判断 */
  async function hasFileId(fileId) {
    return !!(await one('SELECT 1 FROM files WHERE id = $1 AND deleted_at IS NULL', [fileId]));
  }

  async function filesTotalBytes() {
    return Number((await one('SELECT COALESCE(SUM(size), 0) AS s FROM files WHERE deleted_at IS NULL')).s);
  }

  /** 先在库里标记删除（之后 blob 删除失败也会被孤儿回收兜底）；返回是否由本次调用标记 */
  async function markFileDeleted(fileId, reason, client = pool) {
    const r = await client.query(
      'UPDATE files SET deleted_at = $1, deleted_reason = $2 WHERE id = $3 AND deleted_at IS NULL',
      [now(), reason, fileId]
    );
    return r.rowCount > 0;
  }

  /**
   * 收件确认（DESIGN §12 生命周期）：记录 client_id 已收到；全部收件人都确认后标记删除。
   * 上传时频道里没有其他成员的，第一个确认收到的非上传者即触发删除。
   * 上传者自己（同 client_id）的确认不计数。
   * 返回 { deleted, remaining }，deleted=true 表示调用方应删除 blob。
   */
  async function confirmFileReceived(fileId, clientId) {
    return tx(async (c) => {
      const f = await one('SELECT client_id, deleted_at FROM files WHERE id = $1 FOR UPDATE', [fileId], c);
      if (!f || f.deleted_at) return { deleted: false, already_deleted: !!f?.deleted_at, remaining: 0 };
      if (f.client_id === clientId) {
        const n = await one('SELECT COUNT(*) AS n FROM file_recipients WHERE file_id = $1 AND received_at IS NULL', [fileId], c);
        return { deleted: false, remaining: Number(n.n) };
      }
      await c.query(`
        INSERT INTO file_recipients (file_id, client_id, received_at) VALUES ($1, $2, $3)
        ON CONFLICT (file_id, client_id) DO UPDATE SET received_at = COALESCE(file_recipients.received_at, excluded.received_at)
      `, [fileId, clientId, now()]);
      const remaining = Number((await one(
        'SELECT COUNT(*) AS n FROM file_recipients WHERE file_id = $1 AND received_at IS NULL', [fileId], c
      )).n);
      if (remaining > 0) return { deleted: false, remaining };
      await markFileDeleted(fileId, 'delivered', c);
      return { deleted: true, remaining: 0 };
    });
  }

  /** 超过保留期仍未删除的文件：标记 expired，返回 id 列表（调用方删 blob） */
  async function expireFiles(olderThan) {
    const { rows } = await pool.query(`
      UPDATE files SET deleted_at = $1, deleted_reason = 'expired'
      WHERE deleted_at IS NULL AND created_at < $2
      RETURNING id
    `, [now(), olderThan]);
    return rows.map((r) => r.id);
  }

  // ---- cursors（DESIGN §4.2/§4.5/§5：fetch 不动游标，仅 ACK 推进；游标键 = (channel, client_id)）----

  async function getCursorRow(channel, clientId) {
    return one('SELECT cursor, updated_at FROM cursors WHERE channel = $1 AND client_id = $2', [channel, clientId]);
  }

  /**
   * 首次拉取时初始化游标（§5）：
   * cursor = 最近一条「早于 10 分钟前」的消息 seq（没有则为 0），
   * 效果即新订阅者恰好可见最近 10 分钟内的消息。
   * 游标行一旦存在，该 client_id 即为频道成员（文件收件人快照据此圈定）。
   */
  async function ensureCursor(channel, clientId) {
    const existing = await getCursorRow(channel, clientId);
    if (existing) return { cursor: existing.cursor, initialized: false };
    const cutoff = now() - CURSOR_INIT_WINDOW_SECONDS;
    const base = (await one(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE channel = $1 AND created_at < $2',
      [channel, cutoff]
    )).s;
    // 并发首拉时可能撞主键，DO NOTHING 后重读即可
    await q(
      'INSERT INTO cursors (channel, client_id, cursor, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [channel, clientId, base, now()]
    );
    return { cursor: (await getCursorRow(channel, clientId)).cursor, initialized: true };
  }

  /**
   * ACK 推进水位线（§4.2 原则三）：
   * 只进不退（GREATEST），且钳制到 latest_seq，防止静默跳过未来消息。
   */
  async function setCursor(channel, clientId, through) {
    const target = Math.min(through, await latestSeq(channel));
    const row = await one(`
      INSERT INTO cursors (channel, client_id, cursor, updated_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (channel, client_id) DO UPDATE
      SET cursor = GREATEST(cursors.cursor, excluded.cursor), updated_at = excluded.updated_at
      RETURNING cursor
    `, [channel, clientId, target, now()]);
    return row.cursor;
  }

  return {
    pool,
    tx,
    close: () => pool.end(),
    instanceId,
    hasChannel,
    getChannelRow,
    createChannel,
    listChannels,
    latestSeq,
    hasMessage,
    insertMessage,
    messagesSince,
    waitForMessage,
    insertFile,
    getFile,
    hasFileId,
    filesTotalBytes,
    markFileDeleted,
    confirmFileReceived,
    expireFiles,
    getCursorRow,
    ensureCursor,
    setCursor,
  };
}
