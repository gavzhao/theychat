// 频道视图：历史窗口、实时增量（长轮询）、发消息 / 回复 / 文件收发、ack 水位线。theychat API 无认证，全部带 X-Client-Id
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, uploadFile, fileUrl, agentServerUrl, confirmFileReceived } from '../api.js';
import { getId, getFrom } from '../identity.js';
import { clockTime, dayLabel, fileMeta, humanSize, joinInstruction, nameHue } from '../util.js';
import CopyButton from './CopyButton.jsx';

const PAGE = 50;
const WAIT_S = 25;      // 长轮询挂起秒数（服务端上限 60）
const ACK_EVERY_MS = 8000;

function Sender({ name }) {
  return <span className="sender" style={{ '--hue': nameHue(name) }}>{name}</span>;
}

function FileBody({ m, channel }) {
  const file = fileMeta(m);
  if (!file) return <div className="msg-text">{m.content}</div>;
  const onDownload = async (e) => {
    // 浏览器下载后顺手发收件确认（失败静默；web 端不参与可靠性约定）
    e.preventDefault();
    try {
      const res = await fetch(fileUrl(channel, file.file_id));
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
      confirmFileReceived(channel, file.file_id);
    } catch {
      window.open(fileUrl(channel, file.file_id), '_blank', 'noreferrer');
    }
  };
  return (
    <div className="file-card">
      <span className="file-icon" aria-hidden="true">📎</span>
      <div className="file-info">
        <a className="file-name" href={fileUrl(channel, file.file_id)} download={file.name} onClick={onDownload}>{file.name}</a>
        <span className="file-meta">{humanSize(file.size)} · {file.mime} · sha256 {String(file.sha256 ?? '').slice(0, 12)}…</span>
        {file.caption && <p className="file-caption">{file.caption}</p>}
      </div>
    </div>
  );
}

function Body({ m, channel }) {
  const file = fileMeta(m);
  if (file) return <FileBody m={m} channel={channel} />;
  if (m.content_type === 'application/json') {
    let pretty = m.content;
    try { pretty = JSON.stringify(JSON.parse(m.content), null, 2); } catch {}
    return <pre className="msg-json">{pretty}</pre>;
  }
  return <div className="msg-text">{m.content}</div>;
}

function snippet(m) {
  const f = fileMeta(m);
  const text = f ? `📎 ${f.name}` : m.content;
  return text.length > 90 ? text.slice(0, 90) + '…' : text;
}

/** 频道视图：公开频道，人人可读可写。发消息带自报 from；看过的位置 ack 到服务端游标 */
export default function ChannelView({ channel }) {
  const [latestSeq, setLatestSeq] = useState(0);
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const scroller = useRef(null);
  const stickToBottom = useRef(true);
  const restoreFrom = useRef(null);
  const latest = useRef(0);
  const lastAck = useRef(0);
  const fileInput = useRef(null);
  const abortPoll = useRef(null);

  // 初始窗口：先用 since=0&limit=1 摸到 latest_seq，再取最近一页（API 只有 since 正向语义，无 before 反翻页）
  useEffect(() => {
    let cancelled = false;
    abortPoll.current?.abort();
    setMessages([]);
    setError(null);
    stickToBottom.current = true;
    latest.current = 0;
    (async () => {
      try {
        const head = await api('GET', `/v1/channels/${encodeURIComponent(channel)}/messages?since=0&limit=1`);
        if (cancelled) return;
        const max = head.latest_seq ?? 0;
        setLatestSeq(max);
        const page = await api('GET', `/v1/channels/${encodeURIComponent(channel)}/messages?since=${Math.max(0, max - PAGE)}&limit=${PAGE}`);
        if (cancelled) return;
        setMessages(page.messages);
        setHasOlder(page.messages.length > 0 && page.messages[0]?.seq > 1);
        latest.current = page.messages.at(-1)?.seq ?? 0;
      } catch (e) {
        if (!cancelled) setError(e);
      }
    })();
    return () => { cancelled = true; abortPoll.current?.abort(); };
  }, [channel]);

  // 实时增量：长轮询 since=latest&wait=25；标签页不可见或组件卸载时中断
  useEffect(() => {
    if (error) return undefined;
    const ctrl = new AbortController();
    abortPoll.current = ctrl;
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const page = await fetch(
            `/v1/channels/${encodeURIComponent(channel)}/messages?since=${latest.current}&limit=200&wait=${WAIT_S}`,
            { headers: { 'x-client-id': getId() }, signal: ctrl.signal },
          ).then((r) => (r.ok ? r.json() : null));
          if (stop) return;
          if (!page) { await new Promise((r) => setTimeout(r, 3000)); continue; }
          if (page.messages?.length) {
            latest.current = page.messages.at(-1).seq;
            setLatestSeq((n) => Math.max(n, latest.current));
            setMessages((prev) => {
              const seen = new Set(prev.map((m) => m.seq));
              const fresh = page.messages.filter((m) => !seen.has(m.seq));
              return fresh.length ? [...prev, ...fresh] : prev;
            });
          } else if (page.latest_seq != null) {
            setLatestSeq((n) => Math.max(n, page.latest_seq));
          }
        } catch {
          if (stop || ctrl.signal.aborted) return;
          await new Promise((r) => setTimeout(r, 3000)); // 网络抖动：稍等再试
        }
      }
    })();
    return () => { stop = true; ctrl.abort(); };
  }, [channel, error]);

  // ack 水位线：贴底看到最新消息时把浏览器自己的游标推进（只影响本 client_id 的 pending）
  const ackThrough = useCallback(async (through) => {
    const now = Date.now();
    if (now - lastAck.current < ACK_EVERY_MS) return;
    lastAck.current = now;
    try { await api('POST', `/v1/channels/${encodeURIComponent(channel)}/ack`, { through }); } catch {}
  }, [channel]);

  const loadOlder = useCallback(async () => {
    if (!messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      // API 只有 since 正向语义：从 0 正向翻页，收拢窗口之前的更早消息（封顶 3 跳 ≈ 3000 条）
      const oldest = messages[0].seq;
      const older = [];
      let base = 0;
      for (let hop = 0; hop < 3; hop++) {
        const page = await api('GET', `/v1/channels/${encodeURIComponent(channel)}/messages?since=${base}&limit=1000`);
        for (const m of page.messages) if (m.seq < oldest) older.push(m);
        if (page.messages.length < 1000) { setHasOlder(false); break; }
        base = page.messages.at(-1).seq;
        if (base >= oldest - 1) { setHasOlder(false); break; }
        setHasOlder(true);
      }
      const el = scroller.current;
      restoreFrom.current = el ? el.scrollHeight - el.scrollTop : null;
      if (older.length) setMessages((prev) => [...older, ...prev]);
    } catch {} finally {
      setLoadingOlder(false);
    }
  }, [channel, messages, loadingOlder]);

  // 滚动：新消息时贴底；加载更早消息后保持视口位置；贴底即 ack
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restoreFrom.current != null) {
      el.scrollTop = el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
      const top = messages.at(-1)?.seq;
      if (top) ackThrough(top);
    }
  }, [messages, ackThrough]);

  const bySeq = useMemo(() => new Map(messages.map((m) => [m.seq, m])), [messages]);

  const send = useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      await api('POST', `/v1/channels/${encodeURIComponent(channel)}/messages`, {
        content, content_type: 'text/plain', from: getFrom(), ...(replyTo != null ? { reply_to: replyTo } : {}),
      });
      setDraft('');
      setReplyTo(null);
      stickToBottom.current = true;
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }, [channel, draft, replyTo, sending]);

  const sendFile = useCallback(async (input) => {
    const f = input.files?.[0];
    if (!f || uploading) return;
    setUploading(true);
    try {
      const bytes = await f.arrayBuffer();
      await uploadFile(channel, { name: f.name, caption: '', replyTo, from: getFrom() }, bytes);
      setReplyTo(null);
      stickToBottom.current = true;
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
      input.value = '';
    }
  }, [channel, replyTo, uploading]);

  if (error && error.code === 'channel_not_found') {
    return <div className="channel-view"><div className="empty-state"><p>频道「{channel}」不存在。</p></div></div>;
  }

  const instruction = joinInstruction(channel, agentServerUrl());
  const unseen = Math.max(0, latestSeq - (messages.at(-1)?.seq ?? 0));
  let lastDay = null;

  return (
    <div className="channel-view">
      <div className="channel-head">
        <div className="channel-title">
          <h2><span className="hash">#</span>{channel}</h2>
          <span className="channel-sub">
            {messages.length ? `${Math.max(latestSeq, messages.at(-1)?.seq ?? 0)} 条消息` : '加载中…'} · 公开——任何知道服务端地址的人都能读写
          </span>
        </div>
        <div className="channel-actions">
          <CopyButton text={instruction} label="复制 agent 入会指令" className="btn btn-accent-ghost"
            title="复制一行指令，让你的 agent 加入这个频道" />
        </div>
      </div>

      <div className="channel-body">
        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            if (stickToBottom.current) {
              const top = messages.at(-1)?.seq;
              if (top) ackThrough(top);
            }
          }}
        >
          {hasOlder && (
            <div className="load-older">
              <button type="button" className="btn btn-ghost" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? '加载中…' : '加载更早的消息'}
              </button>
            </div>
          )}
          {!error && !messages.length && <div className="empty-state"><p>还没有消息——打个招呼吧。</p></div>}
          {messages.map((m) => {
            const day = dayLabel(m.created_at);
            const showDay = day !== lastDay;
            lastDay = day;
            const parent = m.reply_to != null ? bySeq.get(m.reply_to) : null;
            return (
              <div key={m.seq}>
                {showDay && <div className="day-sep"><span>{day}</span></div>}
                <article className="msg" id={`msg-${m.seq}`} style={{ '--hue': nameHue(m.sender) }}>
                  <header className="msg-head">
                    <Sender name={m.sender} />
                    <span className="msg-time" title={new Date(m.created_at * 1000).toLocaleString()}>{clockTime(m.created_at)}</span>
                    <span className="msg-seq">#{m.seq}</span>
                  </header>
                  {m.reply_to != null && (
                    <a className="reply-ref" href={parent ? `#msg-${m.reply_to}` : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`msg-${m.reply_to}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}>
                      ↳ #{m.reply_to}{parent ? ` ${parent.sender}: ${snippet(parent)}` : ''}
                    </a>
                  )}
                  <Body m={m} channel={channel} />
                  <button type="button" className="msg-reply linklike" title="回复这条消息"
                    onClick={() => setReplyTo(m.seq)}>回复</button>
                </article>
              </div>
            );
          })}
        </div>

        {unseen > 0 && (
          <button type="button" className="new-msgs" onClick={() => {
            const el = scroller.current;
            stickToBottom.current = true;
            el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}>
            {unseen} 条新消息 ↓
          </button>
        )}
      </div>

      <footer className="composer">
        {replyTo != null && (
          <div className="reply-bar">
            回复 #{replyTo}{bySeq.get(replyTo) ? ` ${bySeq.get(replyTo).sender}：${snippet(bySeq.get(replyTo))}` : ''}
            <button type="button" className="linklike" onClick={() => setReplyTo(null)}>取消</button>
          </div>
        )}
        <div className="composer-row">
          <input
            className="composer-input"
            placeholder={`发消息到 #${channel}，署名「${getFrom()}」`}
            value={draft}
            maxLength={65536}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
          <input ref={fileInput} type="file" hidden onChange={(e) => sendFile(e.currentTarget)} />
          <button type="button" className="btn btn-ghost" title="发送文件" disabled={uploading}
            onClick={() => fileInput.current?.click()}>📎</button>
          <button type="button" className="btn btn-primary" disabled={!draft.trim() || sending} onClick={send}>
            {sending ? '…' : '发送'}
          </button>
        </div>
        {error && error.code !== 'channel_not_found' && <p className="form-error">{error.message}</p>}
      </footer>
    </div>
  );
}
