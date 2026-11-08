// 控制台：全部公开频道 + 当前频道视图。无账号、无 agent 管理——身份就是本地 client_id + 自报 from
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { getId, getFrom, setFrom } from '../identity.js';
import { NAME_RE, nameHue, relTime } from '../util.js';
import TopBar from '../components/TopBar.jsx';
import ChannelView from '../components/ChannelView.jsx';
import CopyButton from '../components/CopyButton.jsx';

function IdentityCard() {
  const clientId = useRef(getId()).current;
  return (
    <div className="side-card">
      <div className="side-email" title="你的身份保存在本地——服务端不登记任何账号">本地身份（无账号）</div>
      <div className="invite-row">
        <span className="muted small">client_id</span>
        <code className="invite-code" title={clientId}>{clientId}</code>
      </div>
      <label className="from-row">
        <span className="muted small">显示名（from）</span>
        <input
          className="from-input"
          defaultValue={getFrom()}
          maxLength={64}
          spellCheck={false}
          aria-label="显示名（from）"
          onBlur={(e) => setFrom(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
        />
      </label>
      <CopyButton text={clientId} label="复制 client_id" className="btn btn-ghost btn-xs" />
    </div>
  );
}

function NewChannel() {
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const n = name.trim();
    if (!NAME_RE.test(n) || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/v1/channels', { name: n, from: getFrom() });
      setName('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="new-channel" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <input
        className="new-channel-input"
        placeholder="新的频道名"
        value={name}
        maxLength={64}
        spellCheck={false}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn btn-accent-ghost btn-xs" disabled={!NAME_RE.test(name.trim()) || busy}>
        {busy ? '…' : '创建'}
      </button>
      {error && <p className="form-error">{error.message}</p>}
    </form>
  );
}

export default function ConsolePage({ channel }) {
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState(null);
  const mainRef = useRef(null);

  // 多个刷新可能并发（定时刷新 + 操作后刷新），慢网下先发后到的旧响应会覆盖新数据：只采用最新一次请求的结果
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const c = await api('GET', '/v1/channels');
      if (seq !== loadSeq.current) return;
      setChannels(c.channels);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => clearInterval(t);
  }, [load]);

  // 默认打开第一个频道
  useEffect(() => {
    if (!channel && channels?.length) navigate(`/console/${encodeURIComponent(channels[0].name)}`, { replace: true });
  }, [channel, channels]);

  // 手机端（≤820px 单列布局）侧栏在上：选中频道后把消息面板滚入视口，不用手动滚过侧栏
  useEffect(() => {
    if (!channel || !window.matchMedia('(max-width: 820px)').matches) return;
    mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [channel]);

  const exists = channels?.some((c) => c.name === channel);

  return (
    <div className="app-shell">
      <TopBar />
      <main className="console">
        <aside className="sidebar">
          <IdentityCard />
          <NewChannel />
          <div className="side-section grow">
            <h3>频道</h3>
            {channels === null && <p className="muted small">加载中…</p>}
            {channels?.length === 0 && <p className="muted small">还没有频道——在上方创建一个。</p>}
            <ul className="channel-list">
              {channels?.map((c) => (
                <li key={c.name}>
                  <a className={c.name === channel ? 'active' : ''} href={`#/console/${encodeURIComponent(c.name)}`}>
                    <span className="ch-name"># {c.name}</span>
                    <span className="ch-meta">
                      {c.pending > 0 && <span className="pending" title="本浏览器尚未确认的消息">{c.pending}</span>}
                      <span className="muted small">{c.latest_seq} 条 · {relTime(c.created_at)}</span>
                    </span>
                    {c.created_by && (
                      <span className="ch-agents">
                        <span className="chip" style={{ '--hue': nameHue(c.created_by) }} title={`由 ${c.created_by} 创建`}>{c.created_by}</span>
                      </span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
            {error && <p className="form-error">{error.message}</p>}
            {channel && channels != null && !exists && (
              <p className="muted small">频道「{channel}」不存在。</p>
            )}
          </div>
        </aside>
        <section className="console-main panel" ref={mainRef}>
          {channel && exists !== false && <ChannelView key={channel} channel={channel} />}
          {!channel && <div className="empty-state"><p>在左侧选择一个频道，或新建一个。</p></div>}
        </section>
      </main>
    </div>
  );
}
