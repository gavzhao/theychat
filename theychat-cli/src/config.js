// CLI 身份管理：具名 profile（server + client_id + 显示名），无默认身份（设计见 DESIGN.md）
// 身份模型：client_id 是本地生成一次的透明标签（服务端不建档、不验证），name 是发消息时自报的显示名。
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const CONFIG_DIR = join(homedir(), '.config', 'theychat');
const PROFILES_DIR = join(CONFIG_DIR, 'profiles');

/** profile 名规则 */
const PROFILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** client_id 格式（与服务端一致）：1-64 字符的 [A-Za-z0-9._-] */
export const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function profileFile(profile) {
  if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) {
    throw new Error(`Invalid profile name "${profile}" (1-64 chars of [A-Za-z0-9_-])`);
  }
  return join(PROFILES_DIR, `${profile}.toml`);
}

/** 本地生成新的 client_id（32 位 hex；不访问服务端） */
export function newClientId() {
  return randomBytes(16).toString('hex');
}

export function profileExists(profile) {
  return existsSync(profileFile(profile));
}

export function readProfile(profile) {
  return parseToml(readFileSync(profileFile(profile), 'utf8'));
}

/** 没选身份时的可操作提示：列出本机 profile */
export function noIdentityMessage() {
  const names = listProfiles().map((p) => p.profile);
  const lines = ['No identity selected: pass --profile <name> (or set THEYCHAT_PROFILE=<name>).'];
  lines.push(names.length
    ? `  Identities on this machine: ${names.join(', ')}`
    : '  No identities on this machine yet. Create one with: theychat profile add <name> --server <url>');
  return lines.join('\n');
}

/**
 * 读取当前选中的身份。只认显式指定：
 *   THEYCHAT_PROFILE（--profile 会设置它）→ profiles/<name>.toml，THEYCHAT_SERVER / THEYCHAT_CLIENT_ID / THEYCHAT_FROM 若同时给出则覆盖对应字段；
 *   未指定 profile 时，只有 THEYCHAT_SERVER + THEYCHAT_CLIENT_ID 都给出才可用（此时 from 可用 THEYCHAT_FROM 给出）。
 * 返回 { server, client_id, name, profile }。
 */
export function loadIdentity() {
  const profile = process.env.THEYCHAT_PROFILE;
  const envServer = process.env.THEYCHAT_SERVER;
  const envClientId = process.env.THEYCHAT_CLIENT_ID;
  if (!profile) {
    if (envServer && envClientId) {
      return { server: envServer, client_id: envClientId, name: process.env.THEYCHAT_FROM ?? null, profile: null };
    }
    throw new Error(noIdentityMessage());
  }
  if (!profileExists(profile)) {
    const names = listProfiles().map((p) => p.profile);
    throw new Error(`Profile "${profile}" not found.${names.length ? ` Identities on this machine: ${names.join(', ')}` : ''}`);
  }
  const base = readProfile(profile);
  return {
    server: envServer ?? base.server,
    client_id: envClientId ?? base.client_id,
    name: process.env.THEYCHAT_FROM ?? (base.name || null),
    profile,
  };
}

/** 要求身份齐备（server + 合法 client_id），否则给出可操作的错误提示 */
export function requireIdentity() {
  const cred = loadIdentity();
  if (!cred.server || !cred.client_id) {
    throw new Error(`Profile "${cred.profile}" is incomplete (missing server or client_id); re-create it with theychat profile add`);
  }
  if (!CLIENT_ID_RE.test(cred.client_id)) {
    throw new Error(`Invalid client_id "${cred.client_id}" (1-64 chars of [A-Za-z0-9._-]); fix the profile or THEYCHAT_CLIENT_ID`);
  }
  return cred;
}

/** 保存 profile 到具名文件（0600 权限），返回文件路径 */
export function saveProfile({ server, client_id, name }, profile) {
  const file = profileFile(profile);
  mkdirSync(dirname(file), { recursive: true });
  const toml = [
    `server = ${tomlString(server)}`,
    `client_id = ${tomlString(client_id)}`,
    `name = ${tomlString(name ?? '')}`,
    '',
  ].join('\n');
  writeFileSync(file, toml, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/**
 * 本机全部身份：profiles/*.toml；外加环境变量给出的身份（profile "env"）。
 * 缺 server/client_id 的条目跳过。
 */
export function listProfiles() {
  const out = [];
  if (existsSync(PROFILES_DIR)) {
    for (const f of readdirSync(PROFILES_DIR).sort()) {
      const m = /^(.+)\.toml$/.exec(f);
      if (!m || !PROFILE_RE.test(m[1])) continue;
      const file = join(PROFILES_DIR, f);
      out.push({ profile: m[1], file, ...parseToml(readFileSync(file, 'utf8')) });
    }
  }
  if (process.env.THEYCHAT_CLIENT_ID && process.env.THEYCHAT_SERVER) {
    out.push({
      profile: 'env',
      file: null,
      server: process.env.THEYCHAT_SERVER,
      client_id: process.env.THEYCHAT_CLIENT_ID,
      name: process.env.THEYCHAT_FROM ?? null,
    });
  }
  return out.filter((p) => p.server && p.client_id);
}

export function removeProfile(profile) {
  const file = profileFile(profile);
  if (!existsSync(file)) throw new Error(`Profile "${profile}" not found`);
  rmSync(file);
  return file;
}

function tomlString(s) {
  return JSON.stringify(String(s)); // JSON 字符串转义与 TOML 基本字符串兼容
}

/** 极简扁平 TOML 解析：仅支持 `key = "value"` 行与 # 注释 */
function parseToml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
