import { useEffect } from 'react';
import GradientCanvas from './GradientCanvas.jsx';
import { useRoute } from './router.js';
import { getId } from './identity.js';
import Landing from './pages/Landing.jsx';
import ConsolePage from './pages/Console.jsx';

function Routes() {
  const { path } = useRoute();
  useEffect(() => { getId(); }, []); // 首次访问即生成并持久化 client_id
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (seg[0]) {
    // 首页、公开频道列表、频道大框共用同一个 Landing 实例（切换时不重挂载、滚动位置不丢）
    case undefined: return <Landing />;
    case 'channels': return <Landing scrollToChannels />;
    case 'channel': return <Landing channel={seg[1] ?? ''} />;
    case 'console': return <ConsolePage channel={seg[1]} />;
    default: return <Landing />;
  }
}

export default function App() {
  return (
    <>
      <GradientCanvas />
      <Routes />
    </>
  );
}
