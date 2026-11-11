// 보드 API와 화면을 서빙하는 HTTP 처리부. 로컬 실행(wb board)과 나중의 서버 실행이 같은 처리부를 쓴다(X-2).
//   - 화면은 같은 출처의 이 API만 부른다(X-1). 응답에 CORS 허용 헤더를 넣지 않는다(LB-3)
//   - 요청 앞단에 인증 단계(authenticate)를 끼울 자리가 있다. 로컬 실행은 통과시킨다(X-2)
//   - Host 검사는 실행 쪽 정책으로 받는다(allowedHosts, LB-2). 듣는 주소·포트는 startBoardServer가 받는다(X-4)
//   - 상태는 읽기 모듈의 캐시뿐이다. 재시작해도 같은 응답을 준다(X-5)
//   - 경로는 basePath 아래 상대 경로로 둔다. 리버스 프록시의 하위 경로에서도 돈다(X-6)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { checkPath, checkRef, BoardPathError } from './board-git.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
const MAX_PATHS = 200;

/** 모든 응답에 붙이는 보안 헤더. CORS 허용 헤더는 넣지 않는다 */
function secure(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(res.req?.method === 'HEAD' ? undefined : buf);
}
const json = (res, status, obj) => send(res, status, obj);

/**
 * @param {object} o
 * @param {ReturnType<import('./board-git.mjs').createGitReader>} o.reader
 * @param {string} o.boardText          엔진의 board.yml 내용(D-4). git에서 읽지 않는다
 * @param {object} o.config             화면에 줄 공유 설정 {host, repo, branch, fetchIntervalSec}
 * @param {string|null} o.staticDir     화면 묶음 폴더
 * @param {string} [o.basePath]         예: '/' 또는 '/board/'
 * @param {(req, res) => boolean | Promise<boolean>} [o.authenticate]  false면 처리부가 응답을 끝냈다고 본다
 * @param {string[]|null} [o.allowedHosts]  Host 헤더 허용 목록(소문자). null이면 검사하지 않는다
 * @param {() => object} [o.status]     api/head에 덧붙일 상태(마지막 fetch 등)
 */
export function createBoardHandler({ reader, boardText, config, staticDir, basePath = '/', authenticate = () => true, allowedHosts = null, status = () => ({}) }) {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;

  const api = {
    head: () => ({ commit: reader.head(), worktree: reader.worktree, dirty: reader.dirty(), ...status() }),
    config: () => ({ ...config, worktree: reader.worktree }),
    sources: (q) => {
      const ref = checkRef(q.get('ref'));
      return { commit: ref, boardText, projectsText: reader.readPaths(['projects.tsv'], ref)['projects.tsv'] ?? '', tasks: reader.loadTasks(ref) };
    },
    files: (q) => {
      const ref = checkRef(q.get('ref'));
      const paths = q.getAll('path');
      if (!paths.length || paths.length > MAX_PATHS) throw new BoardPathError(`path는 1~${MAX_PATHS}개다`);
      return { files: reader.readPaths(paths, ref) };
    },
    'last-commit': (q) => ({ commit: reader.lastCommit(q.get('path'), checkRef(q.get('ref'))) }),
  };

  return async function handle(req, res) {
    secure(res);
    try {
      if (allowedHosts && !allowedHosts.includes(String(req.headers.host ?? '').toLowerCase())) {
        return json(res, 403, { error: 'Host가 허용되지 않는다' }); // DNS 재바인딩 차단(LB-2)
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET만 받는다' });
      if (!(await authenticate(req, res))) return undefined;

      const url = new URL(req.url, 'http://board.local');
      if (!url.pathname.startsWith(base) && url.pathname !== base.slice(0, -1)) return json(res, 404, { error: '없는 경로다' });
      const route = url.pathname.slice(base.length);

      if (route.startsWith('api/')) {
        const name = route.slice(4);
        if (name === 'blob') {
          const p = checkPath(url.searchParams.get('path'));
          const buf = reader.readBinary(p, checkRef(url.searchParams.get('ref')));
          if (!buf) return json(res, 404, { error: '파일이 없다' });
          // 기록 안의 SVG가 스크립트를 실행하지 못하게 한다
          return send(res, 200, buf, typeOf(p), { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        }
        if (!Object.hasOwn(api, name)) return json(res, 404, { error: '없는 API다' });
        return json(res, 200, api[name](url.searchParams));
      }
      return serveStatic(res, route);
    } catch (e) {
      if (e instanceof BoardPathError) return json(res, 400, { error: e.message });
      return json(res, 500, { error: e.message });
    }
  };

  function serveStatic(res, route) {
    if (!staticDir) return json(res, 404, { error: '화면이 없다' });
    const rel = decodeURIComponent(route || 'index.html');
    const abs = path.resolve(staticDir, rel);
    if (!abs.startsWith(path.resolve(staticDir) + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: '없는 파일이다' });
    const extra = abs.endsWith('.html') ? { 'Content-Security-Policy': CSP } : {};
    return send(res, 200, fs.readFileSync(abs), typeOf(abs), extra);
  }
}

/**
 * 처리부를 HTTP 서버로 띄운다. port 0이면 빈 포트를 쓴다.
 * @return {Promise<{server: http.Server, port: number, url: string}>}
 */
export function startBoardServer(handler, { host = '127.0.0.1', port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => { handler(req, res); });
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actual = server.address().port;
      resolve({ server, port: actual, url: `http://${host}:${actual}/` });
    });
  });
}
