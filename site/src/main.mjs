// 보드 화면 진입점. 실제 창·보드 API·렌더러를 화면(app.mjs)에 연결한다
import { createBoardApi } from './board-api.mjs';
import { createRenderer } from './render.mjs';
import { createApp } from './app.mjs';

const POLL_MS = 5 * 1000; // 끝 커밋 확인 주기. 서버의 fetch 주기(기본 30초)와 별개로, wb sync 직후 바뀐 ref를 바로 본다

/** 같은 출처의 vendor/에서 한 번만 불러온다(외부 CDN을 쓰지 않는다 — 설치물만으로 동작하게 한다) */
const vendors = {};
function loadVendor(name) {
  const files = { mermaid: ['vendor/mermaid.min.js', () => window.mermaid], hljs: ['vendor/hljs.js', () => window.hljs] };
  const [src, get] = files[name] ?? [];
  if (!src) return Promise.resolve(null);
  vendors[name] ??= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(get() ?? null);
    s.onerror = () => resolve(null);
    document.head.append(s);
  });
  return vendors[name];
}

const api = createBoardApi({ fetch: window.fetch.bind(window) });
api.config()
  .then((cfg) => createApp({ window, data: api, render: createRenderer(window), config: { ...cfg, pollMs: POLL_MS }, loadVendor }).start())
  .catch((e) => { document.getElementById('wb-board').textContent = `보드 서버에 연결하지 못했다: ${e.message}`; });
