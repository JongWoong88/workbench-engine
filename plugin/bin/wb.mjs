#!/usr/bin/env node
// `wb <명령> [인자…]` — workbench 명령 진입점. 플러그인 bin/이 PATH에 올라 스킬과 hook이 이것으로 부른다.
//   명령은 같은 프로세스에서 불러 실행한다. 한 파일로 묶은 설치물에서도 같게 돌게 하려고 명령 목록을 정적 import로 둔다.
//   문서 저장소 위치: 환경변수 WORKBENCH_ROOT > PC별 설정 dataRoot (`wb config set data-root <경로>`)
//   허용 명령만 실행한다. 스킬의 allowed-tools `Bash(wb *)`가 이 명령들을 사전 승인하기 때문이다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = {
  'next-task-id': () => import('../cli/next-task-id.mjs'),
  'new-task': () => import('../cli/new-task.mjs'),
  'move-task': () => import('../cli/move-task.mjs'),
  'archive-task': () => import('../cli/archive-task.mjs'),
  'find-task': () => import('../cli/find-task.mjs'),
  'new-record': () => import('../cli/new-record.mjs'),
  'link-output': () => import('../cli/link-output.mjs'),
  lint: () => import('../cli/lint.mjs'),
  'absorb-candidates': () => import('../cli/absorb-candidates.mjs'),
  sync: () => import('../cli/sync.mjs'),
  config: () => import('../cli/config.mjs'),
  'decision-stats': () => import('../cli/decision-stats.mjs'),
  board: () => import('../cli/board.mjs'),
};
const NAMES = Object.keys(COMMANDS);

const here = path.dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);

function reject(code, message, fix, exit) {
  if (rest.includes('--json')) console.log(JSON.stringify({ ok: false, code, message, fix, owner: 'user', exit }, null, 2));
  else console.error([`거부 [${code}] ${message}`, ...fix.map((f, i) => `  ${i ? '    ' : '수정'}: ${f}`)].join('\n'));
  process.exit(exit);
}

/** 설치 버전. 결정 기록의 하네스 값으로 쓴다(D-15). 버전이 없는 개발 중 엔진은 0.0.0-dev */
function version() {
  try { return JSON.parse(fs.readFileSync(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? '0.0.0-dev'; } catch { return '0.0.0-dev'; }
}

if (cmd === '--version' || cmd === '-v') {
  console.log(version());
  process.exit(0);
}
if (!cmd || cmd === '-h' || cmd === '--help') {
  const { DATA, ENGINE } = await import('../cli/lib/workbench.mjs');
  console.log([
    '사용법: wb <명령> [인자…]   (명령별 사용법: wb <명령> --help)',
    `  명령: ${NAMES.join(', ')}`,
    `  문서: ${DATA.root ? `${DATA.root} (${DATA.source})` : '(정해지지 않음 — wb config set data-root <문서 저장소 경로>)'}`,
    `  엔진: ${ENGINE} (${version()})`,
  ].join('\n'));
  process.exit(cmd ? 0 : 2);
}
if (!Object.hasOwn(COMMANDS, cmd)) {
  reject('WB-COMMAND', `wb로 실행할 수 없는 명령이다: ${cmd}`, [`쓸 수 있는 명령: ${NAMES.join(', ')}`], 2);
}

// 명령 모듈은 process.argv를 `node <명령 파일> 인자…` 모양으로 읽는다. 명령 이름은 argv[1]의 파일 이름이다
process.argv = [process.argv[0], path.join(here, '..', 'cli', `${cmd}.mjs`), ...rest];
await COMMANDS[cmd]();
