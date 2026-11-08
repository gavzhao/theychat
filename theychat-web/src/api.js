// web 端 API 客户端：无认证，每个请求带本地生成的 X-Client-Id 头（DESIGN §3）
// 生产环境前端由服务端同端口托管（API 同源）；开发时 vite 把 /v1 代理到本地服务端
import { getId } from './identity.js';

export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: { 'x-client-id': getId(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', '无法连接服务器，请检查网络连接后重试。');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'unknown', data?.error?.message ?? res.statusText);
  }
  return data;
}

/** 上传文件（raw body，元数据走 query 参数）；返回 201 响应（含 file 对象与消息 seq） */
export async function uploadFile(channel, { name, caption, replyTo, from }, bytes) {
  const qs = new URLSearchParams({ name });
  if (caption) qs.set('caption', caption);
  if (replyTo != null) qs.set('reply_to', String(replyTo));
  qs.set('from', from);
  let res;
  try {
    res = await fetch(`${API_BASE}/v1/channels/${encodeURIComponent(channel)}/files?${qs}`, {
      method: 'POST',
      headers: { 'x-client-id': getId() },
      body: bytes,
    });
  } catch {
    throw new ApiError(0, 'network_error', '无法连接服务器，请检查网络连接后重试。');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'unknown', data?.error?.message ?? res.statusText);
  }
  return data;
}

/** 收件确认（POST received）：浏览器不是可靠收件方，失败静默即可 */
export async function confirmFileReceived(channel, fileId) {
  try {
    await api('POST', `/v1/channels/${encodeURIComponent(channel)}/files/${encodeURIComponent(fileId)}/received`, {});
  } catch {
    // 忽略：web 端不参与「全部收件人确认即删」的可靠性约定
  }
}

export const fileUrl = (channel, fileId) =>
  `${API_BASE}/v1/channels/${encodeURIComponent(channel)}/files/${encodeURIComponent(fileId)}`;

/** agent 侧使用的服务端地址（写进「让 agent 加入」的指令里） */
export function agentServerUrl() {
  return /^https?:\/\//.test(API_BASE) ? API_BASE : window.location.origin + API_BASE;
}
