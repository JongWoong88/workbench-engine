// replay 격리 환경 공용 함수
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Rejection, EXIT } from '../../plugin/cli/lib/report.mjs';
import { WS, git, read, exists } from '../../plugin/cli/lib/workbench.mjs';

export const posixAbs = (p) => path.resolve(p).split(path.sep).join('/');

/** 사례 정의 파일에서 사례 하나를 찾는다 */
export function loadCase(casesFile, id) {
  if (!exists(casesFile)) {
    throw new Rejection({ code: 'REPLAY-CASES-MISSING', message: `사례 정의 파일이 없다: ${casesFile}`, fix: '--cases에 사례 정의 JSON 경로를 준다 (예: replay-cases.json)' });
  }
  const cases = JSON.parse(read(casesFile)).cases ?? [];
  const c = cases.find((x) => x.id === id);
  if (!c) {
    throw new Rejection({ code: 'REPLAY-CASE-UNKNOWN', message: `사례 '${id}'가 정의 파일에 없다`, fix: `정의된 사례 중에서 고른다: ${cases.map((x) => x.id).join(', ')}` });
  }
  return c;
}

/** 실제 작업공간·실제 사용자 설정을 가리키는 경로 표기들. 감사와 경로 바꾸기에 쓴다 */
export function realPathForms() {
  const userClaude = path.join(os.homedir(), '.claude');
  const forms = (p) => {
    const win = path.resolve(p);
    const fwd = win.split(path.sep).join('/');
    return [win, fwd, win.replace(/\\/g, '\\\\')];
  };
  return { workspace: forms(WS), userClaude: [...forms(userClaude), '~/.claude', '~\\.claude', '$HOME/.claude', '%USERPROFILE%\\.claude'] };
}

/** 텍스트 안의 실제 작업공간·사용자 설정 경로를 복제본 경로로 바꾼다 */
export function rewritePaths(text, { workspace, config }) {
  const real = realPathForms();
  const to = (p) => { const win = path.resolve(p); return [win, win.split(path.sep).join('/'), win.replace(/\\/g, '\\\\')]; };
  const pairs = [
    ...real.workspace.map((f, i) => [f, to(workspace)[i]]),
    ...real.userClaude.slice(0, 3).map((f, i) => [f, to(config)[i]]),
    ['~/.claude', to(config)[1]], ['~\\.claude', to(config)[0]],
  ];
  let out = text;
  for (const [from, rep] of pairs) out = out.split(from).join(rep).split(from.toLowerCase()).join(rep);
  return out;
}

/** 특정 커밋까지의 이력만 가진 저장소를 만든다. 원본 저장소의 ref는 건드리지 않는다 */
export function cloneAt(src, commit, dst) {
  if (!exists(path.join(src, '.git'))) {
    throw new Rejection({ code: 'REPLAY-REPO-MISSING', message: `원본 저장소가 없다: ${src}`, fix: '사례 정의의 repos.path를 확인한다 (워크스페이스 기준 경로)', owner: 'user' });
  }
  const full = git(['rev-parse', '--verify', `${commit}^{commit}`], src);
  if (!full.ok) {
    throw new Rejection({ code: 'REPLAY-COMMIT-MISSING', message: `${src}에 커밋 ${commit}이 없다`, fix: ['원본 저장소에서 git fetch로 커밋을 받은 뒤 다시 실행한다', '사례 정의의 commit 값이 맞는지 기록의 base와 대조한다'], owner: 'user' });
  }
  const sha = full.stdout.trim();
  fs.mkdirSync(dst, { recursive: true });
  const steps = [
    ['init', '-q', '-b', 'replay-base'],
    ['fetch', '-q', '--no-tags', posixAbs(src), `${sha}:refs/heads/replay-base-fetched`],
    ['checkout', '-q', '-B', 'replay-base', 'replay-base-fetched'],
    ['branch', '-q', '-D', 'replay-base-fetched'],
  ];
  for (const s of steps) {
    const r = git(s, dst);
    if (!r.ok) throw new Rejection({ code: 'REPLAY-CLONE-FAILED', message: `git ${s.join(' ')} 실패: ${r.stderr.trim()}`, fix: '원본 저장소 상태(손상·잠금)를 확인한다', owner: 'user', exit: EXIT.ENV });
  }
  return sha;
}

/** 디렉터리를 재귀 복사한다. filter가 false면 건너뛴다 */
export function copyDir(src, dst, filter = () => true) {
  fs.cpSync(src, dst, { recursive: true, filter: (s) => filter(s) });
}

/** 디렉터리 아래 .md 파일 목록 */
export function mdFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  if (exists(dir)) walk(dir);
  return out;
}

/**
 * replay 복제본에 넣는 workbench 도구 파일. 보드·기록은 넣지 않는다.
 * 플러그인도 복제본에 넣는다 — 스킬이 읽는 규칙 문서·CLAUDE.md와 wb가 쓰는 bin/이 복제본 안에 있어야 실제 워크스페이스에 닿지 않는다.
 * workbench.local.json(PC별 경로 설정)은 넣지 않는다 — 복제본의 워크스페이스 루트는 WORKSPACE_ROOT로만 정한다
 */
// .gitignore를 함께 복사해 복제본의 첫 커밋에 node_modules가 들어가지 않게 한다(넣으면 git add에 수십 분 걸린다)
export const WB_FILES = ['bin', 'plugin', '.claude-plugin', 'CLAUDE.md', 'projects.tsv', 'package.json', 'package-lock.json', '.gitattributes', '.gitignore', 'node_modules'];

/**
 * 권한 규칙의 절대경로 표기. Windows 경로는 `//d/…`(소문자 드라이브, 콜론 없음)여야 맞는다.
 * `//D:/…`는 오류 없이 아무것에도 맞지 않는다(2026-10-30 Claude Code 2.1.314 실측)
 */
export const ruleAbs = (p) => `//${p.replace(/^\/+/, '').replace(/^([A-Za-z]):\//, (_, d) => `${d.toLowerCase()}/`)}`;

/** 리플레이 전용 설정의 권한. 복제본 안만 쓰고, 실제 워크스페이스·사용자 설정은 막는다. 파일 쓰기 규칙은 Edit 하나가 Write까지 덮는다 */
export function sandboxPermissions({ sbx, ws, realWs, realHome }) {
  return {
    defaultMode: 'dontAsk',
    additionalDirectories: [ws],
    allow: [
      'Read', 'Grep', 'Glob',
      `Edit(${ruleAbs(`${sbx}/workspace`)}/**)`,
      'Bash(wb *)', 'PowerShell(wb *)', `Bash(node bin/:*)`, `Bash(node ${sbx}/workspace/workbench/bin/:*)`,
      `Bash(git -C ${sbx}/:*)`, `PowerShell(git -C ${sbx}/:*)`,
    ],
    deny: [
      `Read(${ruleAbs(realWs)}/**)`, `Edit(${ruleAbs(realWs)}/**)`,
      `Read(${ruleAbs(realHome)}/**)`, `Edit(${ruleAbs(realHome)}/**)`,
      'WebFetch', 'WebSearch',
    ],
  };
}

/**
 * replay-run이 실행할 claude 인자와 환경변수. 플러그인은 복제본의 것을 싣고,
 * workbench 명령은 복제본의 보드·기록에 쓰며 원격 동기화는 건너뛴다(복제본에는 원격이 없다)
 */
export function runInvocation(info, { model } = {}) {
  const plugin = info.plugin ?? `${info.workspace}/workbench/plugin`;
  return {
    args: ['claude', '-p', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', `${info.config}/empty-mcp.json`,
      '--plugin-dir', plugin, '--permission-mode', 'dontAsk', '--output-format', 'stream-json', '--verbose', ...(model ? ['--model', model] : [])],
    env: { CLAUDE_CONFIG_DIR: info.config, WORKBENCH_ROOT: `${info.workspace}/workbench`, WORKSPACE_ROOT: info.workspace, WORKBENCH_SYNC: 'local' },
  };
}

/**
 * 최신 도구와 빈 보드(board.yml만, 이슈 없음)·빈 기록으로 된 workbench를 dst에 만들고 새 git 저장소로 커밋한다.
 * @param {string} src 원본 workbench
 * @param {string} dst 만들 위치
 */
export function makeEmptyWorkbench(src, dst) {
  for (const f of WB_FILES) if (exists(path.join(src, f))) copyDir(path.join(src, f), path.join(dst, f));
  fs.mkdirSync(path.join(dst, 'board', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'board', 'tasks', '.gitkeep'), '');
  fs.mkdirSync(path.join(dst, 'records'), { recursive: true });
  fs.writeFileSync(path.join(dst, 'records', '.gitkeep'), '');
  // user.name은 저장소 설정으로 둔다. 전역 설정이 없는 샌드박스에서도 new-task가 작성자를 정할 수 있게 한다
  for (const s of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'replay'], ['config', 'user.email', 'replay@local'], ['add', '-A'], ['commit', '-qm', 'replay sandbox']]) git(s, dst);
}
