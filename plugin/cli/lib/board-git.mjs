// 보드가 읽는 문서 저장소 clone. 입력은 clone 경로와 ref뿐이다(X-3). PC별 설정을 여기서 읽지 않는다.
//   - 읽기만 한다. 작업 트리를 바꾸지 않고 pull·checkout을 하지 않는다(반드시)
//   - 기본은 git 객체에서 읽는다. worktree가 참이면 작업 트리의 추적 파일을 읽는다(push 전 내용 포함)
//   - 읽을 수 있는 경로는 board/, records/, projects.tsv 아래뿐이다. 경로·ref 검사는 이 모듈이 한다(LB-4)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SHA_RE = /^[0-9a-f]{40}$/;
const ALLOWED = [/^board\/tasks\/[^/]+\.md$/, /^records\/.+/, /^projects\.tsv$/];

export class BoardPathError extends Error { name = 'BoardPathError'; }

/** 요청으로 받은 경로를 검사한다. 상대경로이고, `..`·백슬래시·제어 문자가 없고, 허용한 폴더 아래여야 한다 */
export function checkPath(p) {
  if (typeof p !== 'string' || !p || p.length > 1024) throw new BoardPathError('경로가 비었거나 너무 길다');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    throw new BoardPathError(`허용하지 않는 경로다: ${p}`);
  }
  if (!ALLOWED.some((re) => re.test(p))) throw new BoardPathError(`보드가 읽지 않는 경로다: ${p}`);
  return p;
}

/** ref는 커밋 해시 40자만 받는다(git 옵션 주입 방지) */
export function checkRef(ref) {
  if (typeof ref !== 'string' || !SHA_RE.test(ref)) throw new BoardPathError(`ref는 커밋 해시 40자다: ${String(ref).slice(0, 60)}`);
  return ref;
}

/**
 * @param {{ root: string, ref: string, worktree?: boolean, git?: (args: string[], opts?: object) => {ok: boolean, stdout: string|Buffer, stderr: string} }} o
 *   ref: 보여 줄 브랜치(예: origin/main). worktree면 작업 트리 기준이다
 */
export function createGitReader({ root, ref, worktree = false }) {
  const run = (args, { input, buffer = false, timeout = 60_000 } = {}) => {
    const r = spawnSync('git', args, {
      cwd: root, input, timeout, maxBuffer: 512 * 1024 * 1024, ...(buffer ? {} : { encoding: 'utf8' }),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    return { ok: r.status === 0, stdout: r.stdout ?? (buffer ? Buffer.alloc(0) : ''), stderr: String(r.stderr ?? '') };
  };
  const blobCache = new Map(); // blob sha → 본문. 다시 만들 수 있는 캐시만 둔다(X-5)

  /** 보여 줄 끝 커밋. worktree면 HEAD다 */
  function head() {
    const r = run(['rev-parse', '--verify', '--quiet', `${worktree ? 'HEAD' : ref}^{commit}`]);
    if (!r.ok) throw new Error(`${worktree ? 'HEAD' : ref}를 읽을 수 없다. 원격을 한 번 fetch했는지 확인한다`);
    return r.stdout.trim();
  }

  /** 커밋의 board/tasks/*.md 목록 [{path, sha}] */
  function listTasks(commit) {
    checkRef(commit);
    const r = run(['ls-tree', '-z', commit, '--', 'board/tasks/']);
    if (!r.ok) return [];
    return r.stdout.split('\0').filter(Boolean).map((line) => {
      const [meta, p] = line.split('\t');
      const [, type, sha] = meta.split(' ');
      return { path: p, sha, type };
    }).filter((e) => e.type === 'blob' && /^board\/tasks\/[^/]+\.md$/.test(e.path)).map(({ path: p, sha }) => ({ path: p, sha }));
  }

  /** git cat-file --batch로 여러 객체를 한 번에 읽는다. spec마다 Buffer 또는 null */
  function catBatch(specs) {
    if (!specs.length) return [];
    const r = run(['cat-file', '--batch'], { input: specs.map((s) => `${s}\n`).join(''), buffer: true });
    const out = [];
    let pos = 0;
    const buf = r.stdout;
    for (let i = 0; i < specs.length; i++) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) { out.push(null); continue; }
      const header = buf.subarray(pos, nl).toString('utf8');
      pos = nl + 1;
      const m = /^([0-9a-f]{40}) (\S+) (\d+)$/.exec(header);
      if (!m) { out.push(null); continue; } // "<spec> missing" 등
      const size = Number(m[3]);
      out.push(m[2] === 'blob' ? buf.subarray(pos, pos + size) : null);
      pos += size + 1; // 내용 뒤 줄바꿈
    }
    return out;
  }

  /** 작업 트리에서 추적하는 파일인지 */
  const tracked = (p) => run(['ls-files', '--error-unmatch', '--', p]).ok;

  /** 경로들의 본문 { path: text|null }. 없거나 추적하지 않는 파일은 null */
  function readPaths(paths, commit) {
    checkRef(commit);
    paths.forEach(checkPath);
    if (worktree) {
      return Object.fromEntries(paths.map((p) => [p, tracked(p) && fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : null]));
    }
    const bufs = catBatch(paths.map((p) => `${commit}:${p}`));
    return Object.fromEntries(paths.map((p, i) => [p, bufs[i] ? bufs[i].toString('utf8') : null]));
  }

  /** 이슈 파일 전부. 본문은 blob sha로 캐시한다 */
  function loadTasks(commit) {
    const list = listTasks(commit);
    if (worktree) {
      const texts = readPaths(list.map((t) => t.path), commit);
      // 작업 트리에만 있는 새 이슈 파일(추적 중이지만 아직 커밋하지 않은 것)도 넣는다
      const extra = run(['ls-files', '-z', '--', 'board/tasks/']).stdout.split('\0').filter((p) => /^board\/tasks\/[^/]+\.md$/.test(p) && !(p in texts));
      Object.assign(texts, readPaths(extra, commit));
      return Object.entries(texts).filter(([, text]) => text !== null).map(([p, text]) => ({ path: p, sha: null, text }));
    }
    const missing = list.filter((t) => !blobCache.has(t.sha));
    const bufs = catBatch(missing.map((t) => t.sha));
    missing.forEach((t, i) => { if (bufs[i]) blobCache.set(t.sha, bufs[i].toString('utf8')); });
    return list.map((t) => ({ path: t.path, sha: t.sha, text: blobCache.get(t.sha) ?? '' }));
  }

  /** 파일이 마지막으로 바뀐 커밋. 없으면 null */
  function lastCommit(p, commit) {
    checkRef(commit);
    checkPath(p);
    const r = run(['log', '-1', '--format=%H', commit, '--', p]);
    return r.ok && SHA_RE.test(r.stdout.trim()) ? r.stdout.trim() : null;
  }

  /** 이미지 등 이진 파일. 없으면 null */
  function readBinary(p, commit) {
    checkRef(commit);
    checkPath(p);
    if (worktree) return tracked(p) && fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p)) : null;
    return catBatch([`${commit}:${p}`])[0];
  }

  /** 작업 트리에 커밋하지 않은 추적 파일 변경이 있는지(worktree 표시용) */
  const dirty = () => worktree && run(['status', '--porcelain', '--untracked-files=no', '--', 'board', 'records', 'projects.tsv']).stdout.trim() !== '';

  /** 원격에서 받는다. 실패해도 던지지 않고 결과를 돌려준다 */
  function fetch(remote, branch) {
    const r = run(['fetch', '--quiet', remote, branch], { timeout: 120_000 });
    return { ok: r.ok, error: r.ok ? null : r.stderr.trim().split('\n').slice(-1)[0] || 'fetch 실패' };
  }

  return { head, listTasks, readPaths, loadTasks, lastCommit, readBinary, dirty, fetch, worktree };
}
