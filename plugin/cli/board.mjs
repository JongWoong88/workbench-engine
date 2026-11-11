#!/usr/bin/env node
// 로컬 보드. 문서 저장소 clone을 읽어 127.0.0.1에 보드 화면을 띄운다. 인증이 없다 — clone을 읽을 수 있는 사람이 곧 볼 수 있는 사람이다.
//   보여 주는 것은 원격 기본 브랜치(origin/<branch>)다. 주기적으로 fetch하고, wb sync 직후에는 바로 다시 읽는다.
//   --worktree면 push하지 않은 작업 트리의 추적 파일도 보여 준다(화면 머리에 표시).
//   실행 방식: 터미널이면 그 자리에서 돌고 Ctrl+C로 끝낸다. 터미널이 아니면(agent의 Bash 도구) 백그라운드 프로세스로 띄우고
//   주소를 알린 뒤 바로 돌아온다 — agent가 서버를 붙잡고 기다리지 않게 한다. 끌 때는 `wb board --stop`.
//   떠 있는 보드는 ~/.workbench/board.json(PC별 상태, 설치 폴더 밖)에 적는다. 다시 부르면 떠 있는 보드를 그대로 알린다.
//   --auto는 세션 시작 훅(PC별 설정 boardAutostart)이 부른다. 떠 있으면 아무것도 하지 않고, 새로 띄울 때만 브라우저를 연다.
//   이렇게 띄운 보드는 기록된 Claude Code 세션(hooks/board-sessions.mjs)이 모두 끝나면 잠시 기다렸다가 스스로 꺼진다.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { run, args, usage, Rejection, EXIT } from './lib/report.mjs';
import { WB, ENGINE, REMOTE_NAME, USER_CONFIG_DIR } from './lib/workbench.mjs';
import { BOARD_FILE } from './lib/board.mjs';
import { loadSharedConfig } from './lib/shared-config.mjs';
import { tryWithLock } from './lib/lock.mjs';
import { createGitReader } from './lib/board-git.mjs';
import { createBoardHandler, startBoardServer } from './lib/board-server.mjs';
import { liveSessionCount } from '../hooks/board-sessions.mjs';

const DEFAULT_PORT = 47800;
const USAGE = `사용법: wb board [--port <번호>] [--open] [--worktree] [--no-fetch] [--background]
       wb board --stop
  문서 저장소의 보드를 http://127.0.0.1:<포트>/ 에 띄운다.
  터미널에서 실행하면 그 자리에서 돌고 Ctrl+C로 끝낸다. 터미널이 아니면(에이전트) 백그라운드로 띄우고 바로 돌아온다.
  이미 떠 있으면 새로 띄우지 않고 그 주소를 알린다.
  --port        듣는 포트 (기본 ${DEFAULT_PORT}, 환경변수 WORKBENCH_BOARD_PORT)
  --open        브라우저로 연다
  --worktree    push하지 않은 작업 트리의 내용도 보여 준다
  --no-fetch    원격에서 받지 않는다(지금 clone에 있는 것만 보여 준다)
  --background  터미널에서도 백그라운드로 띄운다
  --stop        백그라운드로 띄운 보드를 끈다
  --auto        세션 시작 훅이 쓴다: 떠 있으면 그대로 두고, 새로 띄울 때만 브라우저를 연다. 세션이 모두 끝나면 꺼진다
  fetch 주기: 공유 설정 board.fetchIntervalSec (기본 30초, 환경변수 WORKBENCH_BOARD_FETCH_SEC)
  상태 파일: ~/.workbench/board.json, 백그라운드 로그: ~/.workbench/board.log`;

/** 보드 화면 묶음 폴더. 설치물은 board-ui/를 가진다. 엔진 개발 중에는 npm run board:build로 만든다(시험은 WORKBENCH_BOARD_UI) */
const BOARD_UI = path.resolve(process.env.WORKBENCH_BOARD_UI || path.join(ENGINE, 'board-ui'));
const STATE = path.join(USER_CONFIG_DIR, 'board.json');
const LOG = path.join(USER_CONFIG_DIR, 'board.log');
/** 백그라운드 실행이 띄운 자식 프로세스 표시. 자식은 그 자리에서 돈다 */
const CHILD = process.env.WORKBENCH_BOARD_CHILD === '1';
/** 세션 훅이 띄운 보드. 세션이 모두 끝나면 꺼진다 */
const AUTO = CHILD && process.env.WORKBENCH_BOARD_AUTO === '1';
const START_TIMEOUT_MS = 20000;
/** 세션 확인 주기와, 세션이 없어진 뒤 끄기까지 기다리는 시간(/clear처럼 끝과 시작이 이어지는 경우를 넘긴다) */
const SESSION_CHECK_MS = Number(process.env.WORKBENCH_BOARD_SESSION_CHECK_MS ?? 5000);
const SESSION_GRACE_MS = Number(process.env.WORKBENCH_BOARD_SESSION_GRACE_MS ?? 20000);

function openBrowser(url) {
  if (process.env.WORKBENCH_BOARD_NO_BROWSER) return; // 시험
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, a, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref(); } catch { /* 주소를 직접 연다 */ }
}

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; } };
const removeState = (pid) => { const s = readState(); if (s && (pid === undefined || s.pid === pid)) fs.rmSync(STATE, { force: true }); };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 그 포트에서 보드 서버가 HTTP로 답하는가 */
function answers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/head', headers: { Host: `127.0.0.1:${port}` }, timeout: 1500 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** 상태 파일의 보드가 살아 있고 답하면 그 상태, 아니면 null */
async function liveBoard() {
  const s = readState();
  if (!s || !Number.isInteger(s.pid) || !Number.isInteger(s.port) || !pidAlive(s.pid)) return null;
  return (await answers(s.port)) ? s : null;
}

function describe(s, extra = {}) {
  const how = s.background ? `백그라운드, pid ${s.pid}` : `터미널에서 실행 중, pid ${s.pid}`;
  return {
    data: { url: s.url, port: s.port, pid: s.pid, background: Boolean(s.background), worktree: Boolean(s.worktree), dataRoot: s.dataRoot, log: s.background ? LOG : undefined, ...extra },
    text: [
      `보드: ${s.url}${extra.reused ? ' (이미 떠 있다)' : ''}`,
      `  ${how}`,
      `  문서 저장소: ${s.dataRoot}${s.worktree ? ' (push 전 내용 포함)' : ''}`,
      s.background ? '  끄려면: wb board --stop' : '  끄려면: 그 터미널에서 Ctrl+C (또는 wb board --stop)',
    ].join('\n'),
  };
}

async function stop() {
  const s = readState();
  if (!s) return { data: { stopped: false }, text: '떠 있는 보드가 없다' };
  if (!Number.isInteger(s.pid) || !pidAlive(s.pid)) {
    removeState();
    return { data: { stopped: false }, text: '보드가 이미 꺼져 있다(남은 상태 파일을 지웠다)' };
  }
  if (!(await answers(s.port))) {
    // pid가 다른 프로세스에 다시 쓰였을 수 있다. 보드가 아닌 프로세스는 끄지 않는다
    removeState();
    return { data: { stopped: false, pid: s.pid }, text: `pid ${s.pid}가 보드로 답하지 않아 끄지 않았다(상태 파일만 지웠다)` };
  }
  process.kill(s.pid);
  for (let i = 0; i < 50 && pidAlive(s.pid); i++) await sleep(100);
  if (pidAlive(s.pid)) {
    throw new Rejection({ code: 'BOARD-STOP-FAILED', message: `보드 프로세스(pid ${s.pid})가 끝나지 않았다`, fix: [`작업 관리자 등에서 pid ${s.pid}를 끝낸다`], owner: 'user', exit: EXIT.ENV });
  }
  removeState(s.pid);
  return { data: { stopped: true, pid: s.pid, url: s.url }, text: `보드를 껐다: ${s.url} (pid ${s.pid})` };
}

/** 자기 자신을 백그라운드 자식으로 띄우고, 자식이 듣기 시작해 상태 파일을 적으면 돌아온다 */
async function startBackground(values, { auto = false } = {}) {
  fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
  // 끝난 보드의 기록만 지운다. 막 뜨는 중인 다른 보드(세션 둘이 함께 시작한 경우)의 기록은 그대로 둔다
  const prev = readState();
  if (prev && (!Number.isInteger(prev.pid) || !pidAlive(prev.pid))) removeState(prev.pid);
  const log = fs.openSync(LOG, 'w');
  const childArgs = [path.join(ENGINE, 'bin', 'wb.mjs'), 'board', '--json',
    ...(values.port ? ['--port', values.port] : []), ...(values.worktree ? ['--worktree'] : []), ...(values['no-fetch'] ? ['--no-fetch'] : [])];
  const child = spawn(process.execPath, childArgs, { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: { ...process.env, WORKBENCH_BOARD_CHILD: '1', WORKBENCH_BOARD_AUTO: auto ? '1' : '' } });
  fs.closeSync(log);

  const outcome = await new Promise((resolve) => {
    const poll = setInterval(() => { const s = readState(); if (s && s.pid === child.pid) finish({ state: s }); }, 100);
    const limit = setTimeout(() => finish({ timeout: true }), START_TIMEOUT_MS);
    child.once('exit', (code) => finish({ exit: code }));
    child.once('error', (e) => finish({ error: e }));
    function finish(v) { clearInterval(poll); clearTimeout(limit); resolve(v); }
  });
  child.removeAllListeners();

  if (outcome.state) {
    child.unref();
    return outcome.state;
  }
  if (outcome.timeout) {
    try { process.kill(child.pid); } catch { /* 이미 끝났다 */ }
    throw new Rejection({ code: 'BOARD-START-TIMEOUT', message: `보드가 ${START_TIMEOUT_MS / 1000}초 안에 뜨지 않았다`, fix: [`로그를 확인한다: ${LOG}`, '원격 fetch가 오래 걸리면 --no-fetch로 다시 띄운다'], owner: 'user', exit: EXIT.ENV });
  }
  // 자식이 거부로 끝났으면 그 거부를 그대로 전한다
  const text = (() => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } })();
  let r = null;
  try { r = JSON.parse(text.slice(text.indexOf('{'))); } catch { /* 형식 밖 출력 */ }
  if (r && r.ok === false) throw new Rejection({ code: r.code, message: r.message, fix: r.fix, owner: r.owner ?? 'user', exit: r.exit ?? EXIT.ENV, file: r.file });
  throw new Rejection({ code: 'BOARD-START-FAILED', message: `보드 프로세스가 바로 끝났다${outcome.error ? `: ${outcome.error.message}` : ` (종료 코드 ${outcome.exit})`}`, fix: [`로그를 확인한다: ${LOG}`], owner: 'user', exit: EXIT.ENV });
}

/** 그 자리에서 서버를 돌린다(터미널, 또는 백그라운드 자식) */
async function serve(values, portText) {
  const shared = loadSharedConfig();
  const fetchSec = Number(process.env.WORKBENCH_BOARD_FETCH_SEC ?? shared.board.fetchIntervalSec);
  const reader = createGitReader({ root: WB, ref: `${REMOTE_NAME}/${shared.branch}`, worktree: Boolean(values.worktree) });
  const state = { fetchedAt: null, fetchError: null };
  const doFetch = () => {
    // wb sync와 git을 함께 쓴다. 잠겨 있으면 이번 회차는 건너뛴다
    const r = tryWithLock(() => reader.fetch(REMOTE_NAME, shared.branch), { label: 'board fetch' });
    if (r.skipped) return;
    state.fetchedAt = new Date().toISOString();
    state.fetchError = r.value.ok ? null : r.value.error;
  };
  if (!values['no-fetch']) doFetch();
  try { reader.head(); } catch (e) {
    throw new Rejection({ code: 'BOARD-NO-REF', message: e.message, fix: [`문서 저장소에서 \`git fetch ${REMOTE_NAME}\`가 되는지 확인한다(아직 push하지 않은 새 저장소면 먼저 push한다)`, 'push하지 않은 내용만 보려면 --worktree'], owner: 'user', exit: EXIT.ENV });
  }

  let started;
  try {
    started = await startBoardServer(() => {}, { host: '127.0.0.1', port: Number(portText) });
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Rejection({ code: 'BOARD-PORT-BUSY', message: `포트 ${portText}를 다른 프로그램이 쓰고 있다`, fix: ['`--port <다른 번호>`로 다시 실행한다. 이미 띄운 보드가 있으면 그 주소를 쓴다'], owner: 'user', exit: EXIT.ENV });
    throw e;
  }
  const { server, port, url } = started;
  const handler = createBoardHandler({
    reader,
    boardText: fs.readFileSync(BOARD_FILE, 'utf8'),
    config: { host: { type: shared.host.type, web: shared.host.web }, repo: shared.repo, branch: shared.branch, fetchIntervalSec: fetchSec },
    staticDir: BOARD_UI,
    // 로컬 실행 정책: 127.0.0.1에만 바인딩하고(LB-1) Host 헤더를 검사한다(LB-2)
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    status: () => ({ fetchedAt: state.fetchedAt, fetchError: state.fetchError }),
  });
  server.removeAllListeners('request');
  server.on('request', handler);
  if (!values['no-fetch'] && fetchSec > 0) setInterval(doFetch, fetchSec * 1000);

  // 떠 있는 보드를 적는다. 다른 살아 있는 보드의 기록은 덮지 않는다
  const me = { pid: process.pid, port, url, dataRoot: WB, worktree: Boolean(values.worktree), background: CHILD, auto: AUTO, startedAt: new Date().toISOString() };
  const prev = readState();
  if (!prev || prev.pid === process.pid || !Number.isInteger(prev.pid) || !pidAlive(prev.pid)) {
    try {
      fs.mkdirSync(USER_CONFIG_DIR, { recursive: true });
      fs.writeFileSync(STATE, `${JSON.stringify(me, null, 2)}\n`);
    } catch { /* 상태를 못 적어도 보드는 돈다 */ }
  }
  const cleanup = () => { try { removeState(process.pid); } catch { /* 끝나는 중 */ } };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(0); });

  // 세션 훅이 띄운 보드: 살아 있는 세션이 없는 채로 SESSION_GRACE_MS가 지나면 끈다(exit 처리가 상태 파일을 지운다)
  if (AUTO) {
    let emptySince = null;
    setInterval(() => {
      let live;
      try { live = liveSessionCount(USER_CONFIG_DIR); } catch { return; }
      if (live > 0) { emptySince = null; return; }
      emptySince ??= Date.now();
      if (Date.now() - emptySince >= SESSION_GRACE_MS) process.exit(0);
    }, SESSION_CHECK_MS);
  }

  if (values.open) openBrowser(url);
  return {
    data: { url, port, pid: process.pid, background: CHILD, worktree: Boolean(values.worktree), dataRoot: WB },
    text: [`보드: ${url}`, `  문서 저장소: ${WB}${values.worktree ? ' (push 전 내용 포함)' : ''}`, values['no-fetch'] ? '  fetch: 하지 않음' : `  fetch: ${fetchSec}초마다 ${REMOTE_NAME}/${shared.branch}`, '  끝내려면 Ctrl+C'].join('\n'),
  };
}

run(async () => {
  const { values } = args({
    port: { type: 'string' }, open: { type: 'boolean' }, worktree: { type: 'boolean' }, 'no-fetch': { type: 'boolean' },
    background: { type: 'boolean' }, stop: { type: 'boolean' }, auto: { type: 'boolean' },
  }, USAGE, { positionals: false });
  if (values.stop) return stop();
  if (values.auto && (values.port || values.worktree || values['no-fetch'] || values.background || values.open)) throw usage('--auto는 다른 옵션과 함께 쓰지 않는다', USAGE);

  const portText = values.port ?? process.env.WORKBENCH_BOARD_PORT ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) throw usage(`포트는 0~65535의 숫자다: ${portText}`, USAGE);
  if (!fs.existsSync(path.join(BOARD_UI, 'index.html'))) {
    throw new Rejection({ code: 'BOARD-UI-MISSING', message: `보드 화면이 없다: ${BOARD_UI}`, fix: ['플러그인을 다시 설치한다', '엔진 저장소에서 개발 중이면 `npm run board:build`로 만든다'], owner: 'user', exit: EXIT.ENV });
  }

  // 터미널(또는 시험의 WORKBENCH_BOARD_ALLOW_NONTTY)이면 그 자리에서, 아니면 백그라운드로
  const foreground = CHILD || (!values.background && !values.auto && (process.stdout.isTTY || process.env.WORKBENCH_BOARD_ALLOW_NONTTY));
  if (foreground) return serve(values, portText);

  const live = await liveBoard();
  if (live) {
    if (values.open) openBrowser(live.url);
    return describe(live, { reused: true });
  }
  const s = await startBackground(values, { auto: Boolean(values.auto) });
  if (values.open || values.auto) openBrowser(s.url);
  return describe(s, { reused: false });
}, USAGE, { needsData: !process.argv.includes('--stop') });
