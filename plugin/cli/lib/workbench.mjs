// workbench 공용 함수(경로, git, 프론트매터, projects.tsv, 이슈 조회). 보드 형식은 board.mjs에 있다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Rejection, EXIT } from './report.mjs';
import { parseProjects } from './model/projects.mjs';

// ── 위치 ──────────────────────────────────────────────────
// 엔진(이 코드가 든 저장소·설치물)과 문서 저장소(board/, records/, projects.tsv)는 따로 있다.
//   엔진:   이 파일 기준으로 정해진다. 엔진 파일(보드 화면 등)은 여기서 찾는다
//   문서:   환경변수 WORKBENCH_ROOT > PC별 설정의 dataRoot. 없으면 명령이 실행될 때 거부한다(requireDataRoot)
//   워크스페이스: 환경변수 WORKSPACE_ROOT > PC별 설정의 workspaceRoot > 문서 저장소의 상위 폴더
export const ENGINE = findEngineRoot(path.dirname(fileURLToPath(import.meta.url)));
/** 이 코드에서 위로 올라가며 .claude-plugin/plugin.json이 있는 폴더(플러그인·설치물 루트)를 찾는다 */
function findEngineRoot(start) {
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(start, '..', '..');
  }
}

// PC별 설정. 설치 폴더는 버전마다 바뀌므로 사용자 홈에 둔다. WORKBENCH_CONFIG_DIR은 시험이 실제 홈을 건드리지 않게 할 때 쓴다
export const USER_CONFIG_DIR = path.resolve(process.env.WORKBENCH_CONFIG_DIR || path.join(os.homedir(), '.workbench'));
export const USER_CONFIG = path.join(USER_CONFIG_DIR, 'config.json');
const CONFIG_CMD = 'wb config';

export function readUserConfig() {
  let text;
  try {
    text = fs.readFileSync(USER_CONFIG, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw configError(e.message);
  }
  let conf;
  try { conf = JSON.parse(text); } catch (e) { throw configError(e.message); }
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) throw configError('최상위 값이 객체가 아니다');
  return conf;
}
const configError = (detail) => new Rejection({
  code: 'ENV-USER-CONFIG', message: `PC별 설정 파일을 읽을 수 없다(${USER_CONFIG}): ${detail}`,
  fix: [`파일을 고치거나 지운 뒤 \`${CONFIG_CMD} set data-root <문서 저장소 경로>\`로 다시 만든다`], owner: 'user', exit: EXIT.ENV,
});

/** PC별 설정을 쓴다. 값이 하나도 없으면 파일을 지운다 */
export function writeUserConfig(conf) {
  const kept = Object.fromEntries(Object.entries(conf).filter(([, v]) => v !== undefined && !(v && typeof v === 'object' && !Object.keys(v).length)));
  if (!Object.keys(kept).length) { fs.rmSync(USER_CONFIG, { force: true }); return; }
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(USER_CONFIG, `${JSON.stringify(kept, null, 2)}\n`);
}

// 모듈을 불러올 때는 거부하지 않는다. 설정이 없어도 `config`·`--help`는 돌아야 하기 때문이다
let userConfError = null;
let userConf = {};
try { userConf = readUserConfig(); } catch (e) { userConfError = e; }

/** 문서 저장소 위치와 그 출처 */
export const DATA = process.env.WORKBENCH_ROOT
  ? { root: path.resolve(process.env.WORKBENCH_ROOT), source: '환경변수 WORKBENCH_ROOT' }
  : typeof userConf.dataRoot === 'string' && userConf.dataRoot
    ? { root: path.resolve(userConf.dataRoot), source: `PC별 설정(${USER_CONFIG})` }
    : { root: null, source: null };

/** 문서 저장소가 문서 저장소처럼 보이는지 (board/가 있다) */
export const looksLikeData = (root) => fs.existsSync(path.join(root, 'board'));

/** 문서 저장소가 필요한 명령은 시작할 때 이것을 부른다(report.mjs run이 대신 부른다) */
export function requireDataRoot() {
  if (userConfError) throw userConfError;
  if (!DATA.root) {
    throw new Rejection({
      code: 'ENV-DATA-ROOT', message: '문서 저장소 위치가 정해지지 않았다',
      fix: [`문서 저장소(board/, records/, projects.tsv가 있는 clone) 경로를 설정한다: \`${CONFIG_CMD} set data-root <경로>\``, '한 번만 다른 저장소를 쓰려면 환경변수 WORKBENCH_ROOT에 경로를 준다'],
      owner: 'user', exit: EXIT.ENV,
    });
  }
  if (!looksLikeData(DATA.root)) {
    throw new Rejection({
      code: 'ENV-DATA-ROOT', message: `문서 저장소가 아니다(board/ 폴더가 없다): ${DATA.root} (${DATA.source})`,
      fix: [`문서 저장소 clone 경로를 확인해 \`${CONFIG_CMD} set data-root <경로>\`로 다시 설정한다`],
      owner: 'user', exit: EXIT.ENV,
    });
  }
}

// 문서 저장소가 없을 때도 경로 계산이 깨지지 않게 존재하지 않는 자리를 둔다. 실제 사용 전에 requireDataRoot가 거부한다
export const WB = DATA.root ?? path.join(USER_CONFIG_DIR, '(data-root-not-set)');
export const WS = path.resolve(process.env.WORKSPACE_ROOT || (typeof userConf.workspaceRoot === 'string' && userConf.workspaceRoot) || path.dirname(WB));
export const WS_SOURCE = process.env.WORKSPACE_ROOT ? '환경변수 WORKSPACE_ROOT' : userConf.workspaceRoot ? `PC별 설정(${USER_CONFIG})` : '문서 저장소의 상위 폴더(기본값)';
/** 저장소 논리 경로 → 이 PC의 실제 폴더 (PC별 설정 repoPaths) */
export const REPO_PATHS = userConf.repoPaths && typeof userConf.repoPaths === 'object' ? userConf.repoPaths : {};
/** 문서 저장소의 git 원격 이름 (PC별 설정 remote, 기본 origin) */
export const REMOTE_NAME = typeof userConf.remote === 'string' && userConf.remote ? userConf.remote : 'origin';
export const RECORDS = path.join(WB, 'records');
export const TSV = path.join(WB, 'projects.tsv');

/** 작업 유형 태그. 브랜치 `{유형}/{task_id}`의 유형과 같다 */
export const TAGS = ['hotfix', 'feature', 'refact', 'improvement', 'research'];
/** 기록 프론트매터 필수 필드 (task_id는 이슈가 있을 때만) */
export const RECORD_FIELDS = ['title', 'lifecycle', 'repos', 'base', 'updated'];
export const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d+$/;

export const posix = (p) => p.split(path.sep).join('/');
export const rel = (abs) => posix(path.relative(WB, abs));
export const read = (p) => fs.readFileSync(p, 'utf8');
export const exists = (p) => fs.existsSync(p);

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function git(args, cwd = WB, opts = {}) {
  // 대화형 로그인 창·프롬프트를 띄우지 않고 실패로 끝낸다 (에이전트가 멈추지 않게). 호출자가 env를 주면 그쪽이 우선한다
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, env, ...opts });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Rejection({ code: 'ENV-GIT', message: 'git을 찾을 수 없다', fix: 'git을 설치하고 PATH에 넣는다', owner: 'user', exit: EXIT.ENV });
  }
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
}

/** 가장 비슷한 후보 (오타 안내용) */
export function suggest(value, candidates) {
  if (!value) return null;
  const v = value.toLowerCase();
  const sub = candidates.find((c) => v.includes(c.toLowerCase()) || c.toLowerCase().includes(v));
  if (sub) return sub;
  const dist = (a, b) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return m[a.length][b.length];
  };
  const best = candidates.map((c) => [c, dist(v, c.toLowerCase())]).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] <= Math.max(2, Math.floor(v.length / 3)) ? best[0] : null;
}

// ── 프론트매터 ──────────────────────────────────────────────
// 이 작업 공간에서 쓰는 형태만 읽는다: `키: 값`, 블록 목록(`- 항목`), 흐름 목록(`[a, b]`).
// 흐름 맵(`{a: b}`)과 그 밖의 값은 문자열 그대로 둔다.
const unquote = (s) => {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) {
    return s[0] === "'" ? s.slice(1, -1).replace(/''/g, "'") : s.slice(1, -1);
  }
  return s;
};

export function parseFrontmatter(text) {
  const t = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  if (!m) return { has: false, data: {}, lines: {}, body: t, bodyLine: 1 };
  const data = {};
  const lines = {};
  let cur = null;
  m[1].split('\n').forEach((line, i) => {
    const kv = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line);
    if (kv) {
      cur = kv[1];
      lines[cur] = i + 2;
      const v = (kv[2] ?? '').trim();
      if (v === '') data[cur] = null;
      else if (v.startsWith('[') && v.endsWith(']')) data[cur] = v.slice(1, -1).split(',').map(unquote).filter(Boolean);
      else data[cur] = unquote(v);
    } else if (cur && /^\s*-\s+/.test(line)) {
      if (!Array.isArray(data[cur])) data[cur] = [];
      data[cur].push(unquote(line.replace(/^\s*-\s+/, '')));
    }
  });
  return { has: true, data, lines, body: t.slice(m[0].length), bodyLine: m[0].split('\n').length };
}

/** YAML 평문 스칼라로 쓰기 곤란한 값만 작은따옴표로 감싼다 */
export function yamlScalar(s) {
  s = String(s);
  return /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|^$|^(true|false|null|yes|no|~)$|^\d/i.test(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

export const h1 = (body) => (/^# (.+)$/m.exec(body) || [])[1]?.trim() ?? null;

// ── projects.tsv ───────────────────────────────────────────
// 파싱은 node: 의존이 없는 model/projects.mjs에 있다(보드 화면와 함께 쓴다)
export { parseProjects };

export const loadProjects = (file = TSV) => parseProjects(read(file));

export function requireProject(projects, project, { owner = 'agent', file } = {}) {
  const row = projects.byProject.get(project);
  if (row) return row;
  const near = suggest(project, projects.names);
  throw new Rejection({
    code: 'PROJECT-UNKNOWN', file,
    message: `project '${project}'가 projects.tsv에 없다`,
    fix: [
      near ? `오타라면 '${near}'를 쓴다` : 'projects.tsv의 project 값 중 하나를 쓴다',
      `사용할 수 있는 값: ${projects.names.join(', ')}`,
      '새 저장소라면 키를 임의로 만들지 말고 사용자에게 확인한 뒤 projects.tsv에 한 줄 추가한다 (형식 문서(references/workbench-format.md) "project와 키 추가")',
    ],
    owner,
  });
}

// ── 서비스 저장소 위치 ───────────────────────────────────────
// projects.tsv의 저장소 열과 기록의 저장소 링크(`../../../../{논리 경로}/…`)는 논리 경로다. 문서 저장소의 상위 폴더를
// 워크스페이스 루트로 보고 쓴다. 이 PC의 실제 폴더는 repoPaths > {workspace-root}/{논리 경로}다. 변환은 이 세 함수로만 한다.

/** 링크가 가정하는 워크스페이스 루트(문서 저장소의 상위 폴더) */
export const LOGICAL_ROOT = path.dirname(WB);

/** 저장소 논리 경로 → 이 PC의 실제 폴더 */
export const repoDir = (logical) => path.resolve(REPO_PATHS[logical] ?? path.join(WS, ...logical.split('/')));

const repoCandidates = (repos) => [...new Set([...repos, ...Object.keys(REPO_PATHS)])].sort((a, b) => b.length - a.length);

/**
 * 링크·산출물이 가리키는 문서 저장소 밖 위치(논리 위치 기준 절대경로)를 저장소와 실제 경로로.
 * 알려진 저장소(projects.tsv, repoPaths) 중 가장 긴 접두를 고르고, 없으면 앞 두 단계({워크스페이스}/{저장소})로 본다.
 * @return {{logical: string, name: string, dir: string, inRepo: string, abs: string} | null}
 */
export function locateRepoPath(abs, repos = []) {
  const r = posix(path.relative(LOGICAL_ROOT, abs));
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return null;
  const logical = repoCandidates(repos).find((c) => r === c || r.startsWith(`${c}/`))
    ?? (r.split('/').length >= 2 ? r.split('/').slice(0, 2).join('/') : null);
  if (!logical) return null;
  const inRepo = r.slice(logical.length + 1);
  const dir = repoDir(logical);
  return { logical, name: logical.split('/').pop(), dir, inRepo, abs: inRepo ? path.join(dir, ...inRepo.split('/')) : dir };
}

/** 이 PC의 실제 경로가 알려진 저장소 안이면 링크용 논리 위치로 바꾼다. 아니면 그대로 */
export function toLogicalPath(abs, repos = []) {
  for (const logical of repoCandidates(repos)) {
    const rr = path.relative(repoDir(logical), abs);
    if (!rr.startsWith('..') && !path.isAbsolute(rr)) return path.join(LOGICAL_ROOT, ...logical.split('/'), rr);
  }
  return abs;
}

/** 저장소 이름(`web`) 또는 경로(`ws/web`)를 projects.tsv의 경로로 */
export function resolveRepo(projects, name) {
  const n = name.replace(/\\/g, '/').replace(/\/$/, '');
  return projects.allRepos.find((r) => r === n || r.split('/').pop() === n) ?? null;
}

// ── 이슈 조회 (board.mjs loadBoardTasks의 결과에 쓴다) ──────
export function findTaskById(tasks, id) {
  return tasks.filter((t) => t.data.task_id === id);
}

export function requireTask(tasks, id) {
  if (!TASK_ID_RE.test(id)) {
    throw new Rejection({ code: 'TASK-ID-FORMAT', message: `'${id}'는 task_id 형식({키}-{번호})이 아니다`, fix: ['task_id를 확인한다. 모르면 `wb find-task <제목 일부>`로 찾는다'], exit: EXIT.USAGE });
  }
  const found = findTaskById(tasks, id);
  if (found.length === 0) {
    throw new Rejection({
      code: 'TASK-NOT-FOUND', message: `task_id ${id}인 이슈가 보드에 없다`,
      fix: ['`wb find-task <제목 일부>`로 이슈를 찾아 task_id를 확인한다', '해당 이슈가 정말 없으면 이슈를 새로 만들지 말고 사용자에게 알린다. 이슈 없는 기록은 records/{project}/에 둔다'],
      owner: 'user',
    });
  }
  if (found.length > 1) {
    throw new Rejection({
      code: 'TASK-ID-DUP', message: `task_id ${id}가 이슈 ${found.length}개에 중복되어 있다: ${found.map((t) => t.rel).join(', ')}`,
      fix: ['중복이 해소되기 전에는 이 task_id로 작업하지 않는다', '어느 이슈에 번호를 새로 발급할지 사용자에게 확인한다 (records 폴더·브랜치가 이미 그 번호를 쓰는 쪽을 유지)'],
      owner: 'user',
    });
  }
  return found[0];
}

export function listFiles(dir) {
  const out = [];
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

/** 지금 실행 중인 명령을 `wb <명령> …`으로 다시 쓴 것 (거부 메시지의 `확인` 줄) */
export function cmdline(extra = []) {
  const [, script, ...a] = process.argv;
  const q = (s) => (/[\s"'|&<>]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return ['wb', path.basename(script ?? '', '.mjs'), ...a.filter((x) => x !== '--json'), ...extra].map(q).join(' ');
}
