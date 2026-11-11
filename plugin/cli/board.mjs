#!/usr/bin/env node
// 로컬 보드. 문서 저장소 clone을 읽어 127.0.0.1에 보드 화면을 띄운다. 인증이 없다 — clone을 읽을 수 있는 사람이 곧 볼 수 있는 사람이다.
//   보여 주는 것은 원격 기본 브랜치(origin/<branch>)다. 주기적으로 fetch하고, wb sync 직후에는 바로 다시 읽는다.
//   --worktree면 push하지 않은 작업 트리의 추적 파일도 보여 주고, 화면 머리에 그렇다고 표시한다.
//   사람이 터미널에서 띄운다. agent의 Bash 도구처럼 터미널이 아닌 곳에서는 띄우지 않고 방법만 안내한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { run, args, usage, Rejection, EXIT } from './lib/report.mjs';
import { WB, ENGINE, REMOTE_NAME } from './lib/workbench.mjs';
import { BOARD_FILE } from './lib/board.mjs';
import { loadSharedConfig } from './lib/shared-config.mjs';
import { tryWithLock } from './lib/lock.mjs';
import { createGitReader } from './lib/board-git.mjs';
import { createBoardHandler, startBoardServer } from './lib/board-server.mjs';

const DEFAULT_PORT = 47800;
const USAGE = `사용법: wb board [--port <번호>] [--open] [--worktree] [--no-fetch]
  문서 저장소의 보드를 http://127.0.0.1:<포트>/ 에 띄운다. 끝내려면 Ctrl+C
  --port      듣는 포트 (기본 ${DEFAULT_PORT}, 환경변수 WORKBENCH_BOARD_PORT)
  --open      브라우저로 연다
  --worktree  push하지 않은 작업 트리의 내용도 보여 준다
  --no-fetch  원격에서 받지 않는다(지금 clone에 있는 것만 보여 준다)
  fetch 주기: 공유 설정 board.fetchIntervalSec (기본 30초, 환경변수 WORKBENCH_BOARD_FETCH_SEC)`;

/** 보드 화면 묶음 폴더. 설치물은 board-ui/를 가진다. 엔진 개발 중에는 npm run board:build로 만든다(시험은 WORKBENCH_BOARD_UI) */
const BOARD_UI = path.resolve(process.env.WORKBENCH_BOARD_UI || path.join(ENGINE, 'board-ui'));

function openBrowser(url) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, a, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).unref(); } catch { /* 주소를 직접 연다 */ }
}

run(async () => {
  const { values } = args({ port: { type: 'string' }, open: { type: 'boolean' }, worktree: { type: 'boolean' }, 'no-fetch': { type: 'boolean' } }, USAGE, { positionals: false });
  if (!process.stdout.isTTY && !process.env.WORKBENCH_BOARD_ALLOW_NONTTY) {
    throw new Rejection({
      code: 'BOARD-NOT-INTERACTIVE', message: '보드는 사람이 터미널에서 띄운다. 이 실행은 터미널이 아니라서 띄우지 않았다',
      fix: ['사용자에게 터미널에서 `wb board --open`을 실행하라고 안내한다. 끝낼 때는 그 터미널에서 Ctrl+C'], owner: 'user', exit: EXIT.ENV,
    });
  }
  const portText = values.port ?? process.env.WORKBENCH_BOARD_PORT ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) throw usage(`포트는 0~65535의 숫자다: ${portText}`, USAGE);
  if (!fs.existsSync(path.join(BOARD_UI, 'index.html'))) {
    throw new Rejection({ code: 'BOARD-UI-MISSING', message: `보드 화면이 없다: ${BOARD_UI}`, fix: ['플러그인을 다시 설치한다', '엔진 저장소에서 개발 중이면 `npm run board:build`로 만든다'], owner: 'user', exit: EXIT.ENV });
  }

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
    throw new Rejection({ code: 'BOARD-NO-REF', message: e.message, fix: [`문서 저장소에서 \`git fetch ${REMOTE_NAME}\`가 되는지 확인한다`, 'push하지 않은 내용만 보려면 --worktree'], owner: 'user', exit: EXIT.ENV });
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
  if (values.open) openBrowser(url);

  return {
    data: { url, port, worktree: Boolean(values.worktree), dataRoot: WB },
    text: [`보드: ${url}`, `  문서 저장소: ${WB}${values.worktree ? ' (push 전 내용 포함)' : ''}`, values['no-fetch'] ? '  fetch: 하지 않음' : `  fetch: ${fetchSec}초마다 ${REMOTE_NAME}/${shared.branch}`, '  끝내려면 Ctrl+C'].join('\n'),
  };
}, USAGE);
