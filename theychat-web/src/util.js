// 展示用小工具
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文 / 旧浏览器兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function relTime(ts) {
  if (!ts) return '—';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return new Date(ts * 1000).toLocaleDateString();
}

export function clockTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return '今天';
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/** 名字 → 稳定的色相，用于发送者着色 */
export function nameHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}

export const FILE_CONTENT_TYPE = 'application/vnd.theychat.file+json';

/** 频道名规则（与服务端 NAME_RE 一致）：1-64 位字母/数字/下划线/连字符 */
export const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 文件消息：content 是一段 JSON（file_id/name/size/sha256/mime/caption/from） */
export function fileMeta(m) {
  if (m.content_type !== FILE_CONTENT_TYPE) return null;
  try {
    return JSON.parse(m.content);
  } catch {
    return null;
  }
}

/** 一行给 agent 的入会指令（theychat 无密码、无注册：报上服务器地址即可） */
export function joinInstruction(channel, server) {
  return `用 theychat 加入我的频道 ${channel}，服务器 ${server}——无需注册，自选一个 client_id。`;
}
