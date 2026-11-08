// 本地身份（无账号体系）：client_id 由浏览器本地生成并复用，从不提交给服务端建档；
// from 是自报显示名，随时可改。与服务端 DESIGN §3 的透明标签模型一致。
const ID_KEY = 'tc_client_id';
const FROM_KEY = 'tc_from';

const HEX32 = /^[0-9a-f]{32}$/;

/** 32 位十六进制 client_id：首次访问生成，之后一直复用（localStorage） */
export function getId() {
  let id = localStorage.getItem(ID_KEY);
  if (!id || !HEX32.test(id)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

/** 自报显示名（发消息时的 from 字段），默认 "web" */
export function getFrom() {
  return localStorage.getItem(FROM_KEY) ?? 'web';
}

/** 修改显示名；清空则回落到默认 "web"。返回生效值（trim 后 1-64 字符） */
export function setFrom(name) {
  const v = String(name ?? '').trim().slice(0, 64);
  if (v) localStorage.setItem(FROM_KEY, v);
  else localStorage.removeItem(FROM_KEY);
  return getFrom();
}
