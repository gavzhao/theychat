#!/usr/bin/env node
// Theychat CLI（设计见 DESIGN.md）：无认证的频道消息——身份只是本地 client_id + 自报 from
import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  loadIdentity, requireIdentity, saveProfile, listProfiles, removeProfile, profileExists, newClientId,
} from './config.js';
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { api, apiRaw, ApiError } from './api.js';
import { cli, contentLines, fileMeta, humanSize } from './render.js';
import { listenForWake } from './wake.js';
import { mountDaemonCommands } from './daemon.js';

const program = new Command();
const CURRENT_VERSION = createRequire(import.meta.url)('../package.json').version;

// 管道下游提前退出（如 `theychat recv ... | head`）时安静收场，不打堆栈
process.stdout?.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

program
  .name('theychat')
  .description('Theychat: account-free channel messaging for agents')
  .version(CURRENT_VERSION)
  .option('--profile <name>', 'Use a saved identity profile (same as THEYCHAT_PROFILE; see theychat profile list)')
  .hook('preAction', () => {
    const { profile } = program.opts();
    if (profile) process.env.THEYCHAT_PROFILE = profile;
  });

function printMessage(m, channel) {
  const time = new Date(m.created_at * 1000).toTimeString().slice(0, 8);
  const reply = m.reply_to != null ? `  ↳#${m.reply_to}` : '';
  console.log(`#${m.seq}  ${m.sender}  ${time}${reply}`);
  for (const line of contentLines(m, channel)) {
    console.log(`  ${line}`);
  }
}

/** 统一错误出口 */
async function run(fn) {
  try {
    await fn();
  } catch (e) {
    if (e.reported) {
      // 已在上下文里打印过（如撞名 + 建议）
    } else if (e instanceof ApiError) {
      console.error(`✗ [${e.code}] ${e.message}`);
    } else {
      console.error(`✗ ${e.message}`);
    }
    process.exitCode = 1;
  }
}

/**
 * agent 友好提示：agent 常忘记「发完/入频后挂后台监听」「处理完重新挂监听」，
 * 在关键操作的输出里直接提醒（走 stderr，不污染 stdout 机器可读输出）。
 * 设 THEYCHAT_NO_HINTS=1 可全局关闭。
 */
function hint(msg) {
  if (process.env.THEYCHAT_NO_HINTS === '1') return;
  console.error(`💡 ${msg}`);
}

/** 从 stdin 读取全部输入（仅当 stdin 非终端时） */
function readStdinIfPiped() {
  if (process.stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf.replace(/\n$/, '')));
    process.stdin.on('error', reject);
  });
}

/** 发送者显示名：--from 覆盖 → profile 的 name → 报错让用户补 */
function senderName(cred, from) {
  const name = from ?? cred.name;
  if (!name) {
    throw new Error('No sender name: pass --from <name>, set THEYCHAT_FROM, or create the profile with --display-name');
  }
  return name;
}

// ---------- profiles：同一台机器上的多身份 ----------

const profile = program
  .command('profile')
  .description('Manage local identity profiles (several agents on one machine; select one with --profile or THEYCHAT_PROFILE)');

profile
  .command('add <name>')
  .description('Create a profile: generates a client_id locally (no server contact, nothing to approve)')
  .requiredOption('--server <url>', 'Server URL')
  .option('--display-name <name>', 'Display name used as the default sender name (--from) when sending')
  .action((name, opts) => run(async () => {
    const client_id = newClientId();
    const existed = profileExists(name);
    const file = saveProfile({ server: opts.server, client_id, name: opts.displayName ?? null }, name);
    console.log(`✓ Profile ${name}${existed ? ' (replaced the previous one)' : ''}: client_id=${client_id}${opts.displayName ? ` name=${opts.displayName}` : ''} @ ${opts.server}`);
    console.log(`  (Saved to ${file}; use it with: theychat --profile ${name} … or THEYCHAT_PROFILE=${name})`);
  }));

profile
  .command('list')
  .description('List local identity profiles (a client_id is a public label, not a secret)')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((opts) => run(async () => {
    const rows = listProfiles().map(({ profile: p, name, client_id, server }) => ({
      profile: p, name: name ?? null, client_id, server,
    }));
    if (opts.output === 'json') {
      console.log(JSON.stringify({ profiles: rows }, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('(No profiles. Create one with: theychat profile add <name> --server <url> --display-name <n>)');
      return;
    }
    const pad = (v, n) => String(v ?? '-').padEnd(n);
    const w = Math.max(16, ...rows.map((r) => r.profile.length + 2));
    console.log(`${pad('PROFILE', w)}${pad('NAME', 20)}${pad('CLIENT_ID', 36)}SERVER`);
    for (const r of rows) {
      console.log(`${pad(r.profile, w)}${pad(r.name, 20)}${pad(r.client_id, 36)}${r.server}`);
    }
  }));

profile
  .command('remove <name>')
  .description('Delete a profile file (nothing server-side is affected)')
  .action((name) => run(async () => {
    const file = removeProfile(name);
    console.log(`✓ Removed ${file}`);
  }));

// ---------- 频道 ----------

const channel = program.command('channel').description('Channel management');
channel
  .command('create <name>')
  .description('Create a channel (all channels are public; anyone with the server URL can read and send)')
  .action((name) => run(async () => {
    const cred = requireIdentity();
    const resp = await api(cred, 'POST', '/v1/channels', { body: { name } });
    console.log(`✓ Channel created: ${resp.name} (by ${resp.created_by ?? '-'})`);
    hint(`Invite another agent — give them the server URL (${cred.server}) and the channel name (${resp.name}); they can read and send right after creating a profile`);
  }));

program
  .command('channels')
  .description('List channels (with your cursor and pending backlog)')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((opts) => run(async () => {
    const cred = requireIdentity();
    const resp = await api(cred, 'GET', '/v1/channels');
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    if (resp.channels.length === 0) {
      console.log('(No channels)');
      return;
    }
    const pad = (s, n) => String(s ?? '-').padEnd(n);
    console.log(`${pad('CHANNEL', 20)}${pad('LATEST', 8)}${pad('CURSOR', 8)}${pad('PENDING', 8)}CREATED_BY`);
    for (const ch of resp.channels) {
      console.log(`${pad(ch.name, 20)}${pad(ch.latest_seq, 8)}${pad(ch.my_cursor, 8)}${pad(ch.pending, 8)}${ch.created_by ?? '-'}`);
    }
  }));

// ---------- 收发 ----------

program
  .command('send <channel> [text]')
  .description('Publish a message; reads stdin when no text argument is given. With --file, uploads a file (text becomes its caption)')
  .option('--from <name>', 'Sender display name (falls back to the profile name)')
  .option('--reply-to <seq>', 'Quote another message by its seq in the same channel', Number)
  .option('--json', 'Publish as application/json; content read from stdin')
  .option('--file <path>', 'Send a file (e.g. a result CSV) as a file message; the server caps file size (default 25 MiB)')
  .action((chName, text, opts) => run(async () => {
    const cred = requireIdentity();
    const from = senderName(cred, opts.from);
    if (opts.file) {
      if (opts.json) throw new Error('--file and --json cannot be used together');
      await sendFile(cred, chName, opts.file, text, opts.replyTo, from);
      hint(`Arm a background listener for replies (run it in a background shell): ${cli()} recv ${chName} --listen`);
      return;
    }
    let content = text;
    let content_type = 'text/plain';
    if (opts.json) {
      content = await readStdin();
      content_type = 'application/json';
    } else if (!content) {
      content = await readStdinIfPiped();
    }
    if (!content) {
      throw new Error('Empty message: pass text as an argument or pipe content via stdin');
    }
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/messages`, {
      body: { content, content_type, reply_to: opts.replyTo, from },
    });
    console.log(`✓ Published to ${resp.channel}: seq=${resp.seq} sender=${resp.sender}`);
    hint(`Arm a background listener for replies (run it in a background shell): ${cli()} recv ${chName} --listen`);
  }));

// ---------- recv --listen：常驻监听（设计见 SKILL.md「Listening」） ----------

program
  .command('recv <channel>')
  .description('Fetch messages (prints then auto-ACKs by default; use --no-ack for programmatic consumption)')
  .option('--wait <sec>', 'Long-poll seconds 0-60', Number, 30)
  .option('--listen', 'Stay armed: silent long-poll until messages from OTHERS arrive, write them to an inbox file, print one THEYCHAT-WAKE line and exit (your own messages are silently ACKed and never wake you; others\' messages are never auto-ACKed; survives silence indefinitely)')
  .option('--limit <n>', 'Max messages returned per call', Number, 100)
  .option('--no-ack', 'Read without ACKing (forced read-only when --since is given)')
  .option('--since <seq>', 'Temporarily override the start position (does not touch the cursor)', Number)
  .option('--from-start', 'Replay full history from seq=0 (does not touch the cursor)')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireIdentity();
    if (opts.listen) {
      if (opts.since !== undefined || opts.fromStart) throw new Error('--listen cannot be combined with --since or --from-start');
      if (opts.output === 'json') throw new Error('--listen prints a fixed THEYCHAT-WAKE line; drop -o json');
      const w = await listenForWake(cred, chName, opts);
      console.log(w.wakeLine);
      console.log('Next: read the inbox file, handle every message, run _meta.ack_command, then run _meta.rearm_command in this same turn (re-arm). Ending the turn without re-arming breaks the wake chain.');
      return;
    }
    if (opts.since !== undefined && opts.fromStart) {
      throw new Error('--since and --from-start cannot be used together');
    }
    const explicit = opts.fromStart ? 0 : opts.since;
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/messages`, {
      query: {
        since: explicit,
        wait: opts.wait,
        limit: opts.limit,
      },
    });

    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
    } else if (resp.messages.length === 0) {
      console.log('(No new messages)');
    } else {
      for (const m of resp.messages) printMessage(m, chName);
    }

    if (explicit !== undefined) {
      // 显式回放是纯读，绝不自动消费（§4.5）
      if (opts.ack) console.log('(Auto-ACK skipped: explicit since/from-start replay never touches the cursor)');
      return;
    }
    if (resp.cursor_initialized && opts.output !== 'json') {
      console.log(`Note: starting from messages newer than 10 minutes. For full history: ${cli()} recv ${chName} --from-start`);
    }
    if (resp.messages.length > 0 && opts.ack) {
      const through = resp.messages[resp.messages.length - 1].seq;
      await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
        body: { through },
      });
      console.log(`ACKed through ${through} (--no-ack disables auto-consume)`);
      hint(`After handling, re-arm your background listener: ${cli()} recv ${chName} --listen`);
    }
  }));

async function sendFile(cred, chName, filePath, caption, replyTo, from) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }
  const data = readFileSync(filePath);
  const res = await apiRaw(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/files`, {
    query: { name: basename(filePath), caption: caption || undefined, reply_to: replyTo, from },
    body: data,
    contentType: 'application/octet-stream',
    timeoutMs: 600_000,
  });
  const resp = await res.json();
  console.log(`✓ Published file to ${resp.channel}: seq=${resp.seq} sender=${resp.sender}`);
  console.log(`  📎 ${resp.file.name} (${humanSize(resp.file.size)}, ${resp.file.mime}) sha256=${resp.file.sha256.slice(0, 12)}…`);
}

program
  .command('download <channel> <seq>')
  .description('Download the file of message #seq (sha256-verified; cursor untouched). Files are deleted from the server once every recipient has downloaded them')
  .option('-o, --output <path>', 'Output path ("-" for stdout); defaults to the original file name in the current directory')
  .option('-f, --force', 'Overwrite an existing output file')
  .action((chName, seqArg, opts) => run(async () => {
    const cred = requireIdentity();
    const seq = Number(seqArg);
    if (!Number.isInteger(seq) || seq < 1) throw new Error('seq must be a positive integer');
    const ch = encodeURIComponent(chName);
    const page = await api(cred, 'GET', `/v1/channels/${ch}/messages`, { query: { since: seq - 1, limit: 1 } });
    const m = page.messages[0];
    if (!m || m.seq !== seq) throw new Error(`Message #${seq} not found in ${chName}`);
    const meta = fileMeta(m);
    if (!meta) throw new Error(`Message #${seq} in ${chName} is not a file message`);

    const toStdout = opts.output === '-';
    const out = opts.output && !toStdout ? opts.output : basename(meta.name);
    if (!toStdout && existsSync(out) && !opts.force) {
      throw new Error(`${out} already exists (use -f to overwrite or -o <path>)`);
    }

    const res = await apiRaw(cred, 'GET', `/v1/channels/${ch}/files/${encodeURIComponent(meta.file_id)}`, {
      timeoutMs: 600_000,
    });
    const hash = createHash('sha256');
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const part = `${out}.part`;
    const sink = toStdout ? process.stdout : createWriteStream(part);
    try {
      await pipeline(Readable.fromWeb(res.body), tap, sink, { end: !toStdout });
    } catch (e) {
      if (!toStdout) rmSync(part, { force: true });
      throw e;
    }
    const digest = hash.digest('hex');
    if (digest !== meta.sha256) {
      if (!toStdout) rmSync(part, { force: true });
      throw new Error(`sha256 mismatch (expected ${meta.sha256}, got ${digest}); download discarded`);
    }
    if (!toStdout) renameSync(part, out);
    // 收件确认：sha256 校验通过才算收到；全部收件人确认后服务端删除文件（接收即删除）。
    // 确认失败不影响已保存的本地文件。
    const receipt = await api(cred, 'POST', `/v1/channels/${ch}/files/${encodeURIComponent(meta.file_id)}/received`)
      .catch(() => null);
    if (toStdout) return;
    console.log(`✓ Saved ${out} (${humanSize(meta.size)}, sha256 verified)`);
    if (receipt?.deleted) {
      console.log('  (every recipient has it now — the server copy was deleted; this local file is the only copy)');
    } else if (receipt) {
      console.log(`  (server copy kept until ${receipt.remaining_recipients} more recipient(s) download it, or it expires)`);
    }
  }));

program
  .command('ack <channel>')
  .description('Advance the cursor watermark: declare "everything with seq <= through is fully handled"')
  .requiredOption('--through <seq>', 'Watermark seq', Number)
  .action((chName, opts) => run(async () => {
    const cred = requireIdentity();
    const resp = await api(cred, 'POST', `/v1/channels/${encodeURIComponent(chName)}/ack`, {
      body: { through: opts.through },
    });
    console.log(`✓ cursor=${resp.cursor}`);
  }));

program
  .command('cursor <channel>')
  .description('Show your cursor in a channel')
  .option('-o, --output <fmt>', 'Output format: text|json', 'text')
  .action((chName, opts) => run(async () => {
    const cred = requireIdentity();
    const resp = await api(cred, 'GET', `/v1/channels/${encodeURIComponent(chName)}/cursor`);
    if (opts.output === 'json') {
      console.log(JSON.stringify(resp, null, 2));
      return;
    }
    console.log(resp.cursor == null
      ? `(Cursor not initialized: the first recv starts from messages newer than 10 minutes)`
      : `cursor=${resp.cursor}  updated_at=${new Date(resp.updated_at * 1000).toISOString()}`);
  }));

// ---------- 人类视图 ----------

program
  .command('tui')
  .description('Read-only terminal UI for humans: every channel with a cursor for any local identity, with messages and cursors (never ACKs)')
  .option('--json', 'Print one snapshot of the same model as JSON and exit (for scripts/tests)')
  .option('--tail <n>', 'Messages loaded per channel', Number, 200)
  .option('--interval <sec>', 'Refresh interval in seconds', Number, 3)
  .action((opts) => run(async () => {
    const { runTui, snapshot } = await import('./tui.js');
    if (opts.json) {
      console.log(JSON.stringify(await snapshot({ tail: opts.tail }), null, 2));
      return;
    }
    await runTui({ tail: opts.tail, interval: opts.interval });
  }));

// ---------- 服务 ----------

program
  .command('serve')
  .description('Start the theychat-backend (for development inside the monorepo; deploy theychat-backend separately in production)')
  .option('--database-url <url>', 'Postgres connection URL (default: $DATABASE_URL)')
  .option('--host <host>', 'Listen address', '0.0.0.0')
  .option('--port <port>', 'Listen port', '8000')
  .action((opts) => {
    let serverJs;
    try {
      const require = createRequire(import.meta.url);
      const pkg = require.resolve('theychat-backend/package.json');
      serverJs = join(dirname(pkg), 'src', 'server.js');
    } catch {
      console.error('✗ theychat-backend not found. Run inside the monorepo (npm run dev), or install theychat-backend separately.');
      process.exitCode = 1;
      return;
    }
    const child = spawn(process.execPath, [serverJs], {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...(opts.databaseUrl ? { DATABASE_URL: opts.databaseUrl } : {}),
        HOST: opts.host,
        PORT: opts.port,
      },
    });
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => child.kill(sig));
    }
    child.on('exit', (code) => (process.exitCode = code ?? 0));
  });

mountDaemonCommands(program, { requireIdentity, run });

program.parseAsync(process.argv);
