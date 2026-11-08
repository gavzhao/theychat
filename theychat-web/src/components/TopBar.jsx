// 顶栏：品牌 + 导航 + 本地身份（client_id 前 8 位 + 可编辑自报显示名 from）。无登录/登出——身份是本地的
import { useEffect, useRef, useState } from 'react';
import { getId, getFrom, setFrom } from '../identity.js';
import { useRoute } from '../router.js';
import ThemeToggle from './ThemeToggle.jsx';

/** 身份小组件：client_id 前 8 位（只读）+ 自报显示名（点击即改） */
function Identity() {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(getFrom);
  const input = useRef(null);
  const clientId = useRef(getId()).current;
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const commit = () => { setName(setFrom(input.current?.value)); setEditing(false); };
  return (
    <span className="identity" title={`你的身份保存在本地：client_id ${clientId}，显示名为自报`}>
      <code className="identity-id">{clientId.slice(0, 8)}</code>
      {editing ? (
        <input
          ref={input}
          className="identity-from-input"
          value={name}
          maxLength={64}
          spellCheck={false}
          aria-label="显示名（from）"
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button type="button" className="identity-from linklike" title="点击修改显示名（发送时作为 from）"
          onClick={() => setEditing(true)}>
          {name}
        </button>
      )}
    </span>
  );
}

export default function TopBar({ transparent = false }) {
  const { path } = useRoute();
  const onConsole = path.startsWith('/console');
  return (
    <header className={`topbar${transparent ? ' is-transparent' : ''}`}>
      <a className="brand" href="#/">theychat</a>
      <nav className="topnav">
        <a href="#/channels">公开频道</a>
        {!onConsole && <a href="#/console">控制台</a>}
        <Identity />
        <ThemeToggle />
      </nav>
    </header>
  );
}
