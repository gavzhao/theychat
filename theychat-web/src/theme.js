// 主题：首访固定亮色（浅蓝界面），手动切换后记住选择（localStorage）。
// index.html 里的内联脚本在首帧前就设好 data-theme，避免闪烁（逻辑与本文件一致）
import { useEffect, useState } from 'react';

const KEY = 'theychat.theme';

export function resolvedTheme() {
  const saved = localStorage.getItem(KEY);
  return saved === 'dark' ? 'dark' : 'light';
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState(resolvedTheme);
  useEffect(() => {
    apply(theme);
  }, [theme]);
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    setTheme(next);
  };
  return { theme, toggle };
}
