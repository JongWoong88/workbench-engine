// 보드 API 클라이언트. 같은 출처의 wb board 서버만 부른다(X-1). 주소는 페이지 기준 상대 경로다(X-6).
// 화면(app.mjs)이 쓰는 읽기: 끝 커밋, 보드 원문, 여러 파일 본문, 파일의 마지막 커밋, 이진 파일, 설정
export class NetworkError extends Error { name = 'NetworkError'; }
export class AccessError extends Error { name = 'AccessError'; } // 401·403 — 서버 보드의 인증 단계가 막았다

const CHUNK = 100; // 한 요청의 경로 수(서버 상한 200 안)

/**
 * @param {{ fetch?: typeof fetch, base?: string }} [o]  base: API 앞에 붙일 경로(기본 '' — 페이지 기준 상대)
 */
export function createBoardApi({ fetch: f = globalThis.fetch, base = '' } = {}) {
  async function call(name, params = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) q.append(k, x);
    let res;
    try {
      res = await f(`${base}api/${name}${q.size ? `?${q}` : ''}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (e) {
      throw new NetworkError(`보드 서버에 연결하지 못했다(wb board가 떠 있는지 확인한다): ${e.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new AccessError(`보드를 볼 수 없다(${res.status})`);
    return res;
  }
  async function json(name, params) {
    const res = await call(name, params);
    if (!res.ok) {
      let msg = `보드 서버 응답 ${res.status}`;
      try { msg = (await res.json()).error ?? msg; } catch { /* 본문 없음 */ }
      throw new NetworkError(msg);
    }
    return res.json();
  }

  /** { commit, worktree, dirty, fetchedAt, fetchError } */
  const head = () => json('head');
  const headCommit = async () => (await head()).commit;
  /** 공유 설정 중 화면이 쓰는 값 { host, repo, branch, fetchIntervalSec, worktree } */
  const config = () => json('config');

  /** 보드를 조립할 원문 { commit, boardText, projectsText, tasks: {path, sha, text}[] } */
  async function loadBoardSources(commit) {
    const src = await json('sources', { ref: commit });
    return { ...src, fetched: src.tasks.length };
  }

  /** 경로들의 본문 { path: text|null }. 없는 파일은 null */
  async function readPaths(paths, ref) {
    const out = {};
    for (let i = 0; i < paths.length; i += CHUNK) Object.assign(out, (await json('files', { ref, path: paths.slice(i, i + CHUNK) })).files);
    return out;
  }
  const readFile = async (path, ref) => (await readPaths([path], ref))[path] ?? null;
  const lastCommit = async (path, ref) => (await json('last-commit', { ref, path })).commit;

  /** 이미지 등 이진 파일 → Blob. 없으면 null */
  async function readBinary(path, ref) {
    const res = await call('blob', { ref, path });
    if (res.status === 404) return null;
    if (!res.ok) throw new NetworkError(`보드 서버 응답 ${res.status}`);
    return res.blob();
  }

  return { head, headCommit, config, loadBoardSources, readPaths, readFile, lastCommit, readBinary };
}
