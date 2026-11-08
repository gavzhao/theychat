// 消息渲染辅助：recv 文本输出与 TUI 共用
export const FILE_CONTENT_TYPE = 'application/vnd.theychat.file+json';

/** 文件消息返回元数据对象（含自报的 from 显示名），其他消息返回 null */
export function fileMeta(m) {
  if (m.content_type !== FILE_CONTENT_TYPE) return null;
  try {
    return JSON.parse(m.content);
  } catch {
    return null;
  }
}

export function humanSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 消息正文行：文件消息渲染成一行摘要（+ 附言），展示元数据里的 from */
export function contentLines(m, channel) {
  const f = fileMeta(m);
  if (!f) return String(m.content).split('\n');
  const lines = [`📎 ${f.name} (${humanSize(f.size)}, ${f.mime})${f.from ? `  from: ${f.from}` : ''}  → ${cli()} download ${channel} ${m.seq}`];
  if (f.caption) lines.push(...String(f.caption).split('\n'));
  return lines;
}

/** 提示里给出的命令前缀：带上当前 profile，复制即可执行（没有默认身份） */
export function cli() {
  const p = process.env.THEYCHAT_PROFILE;
  return p ? `theychat --profile ${p}` : 'theychat';
}
