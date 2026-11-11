#!/usr/bin/env node
// SessionStart hook — 플러그인이 켜진 세션에 workbench 도구, 규칙 문서, 문서 저장소 위치를 알린다.
//   bin/의 `wb`는 PATH에만 오르고 모델에게 따로 알려지지 않는다. 그래서 스킬을 거치지 않고 보드 이슈를 다루는 경우에도
//   규칙 문서에 닿도록 세션 시작 때 안내를 싣는다.
//   문서 저장소 위치는 `wb`와 같은 순서로 찾는다: 환경변수 WORKBENCH_ROOT > PC별 설정(~/.workbench/config.json)의 dataRoot
//   출력(plain stdout)은 Claude Code가 세션 컨텍스트로 넣는다. 상한 10,000자 — 안내와 경로만 싣고 규칙 본문은 싣지 않는다.
//   어떤 경우에도 세션 시작을 막지 않는다: 실패하면 아무것도 출력하지 않고 0으로 끝낸다.
//   PC별 설정 boardAutostart가 켜져 있으면 이 세션을 보드 세션으로 기록하고(board-sessions.mjs) 보드를 백그라운드로 띄운다.
//   보드를 새로 띄울 때만 브라우저가 열린다. 비대화형 실행(claude -p)에는 띄우지 않는다. 훅은 기다리지 않고 바로 끝난다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerSession, findClaudeProcess, isHeadless } from './board-sessions.mjs';

const toPosix = (p) => p.split(path.sep).join('/');

try {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const rules = path.join(pluginRoot, 'references', 'workbench-rules.md');
  const formatSpec = path.join(pluginRoot, 'references', 'workbench-format.md');
  if (!fs.existsSync(rules)) process.exit(0);

  const data = dataRoot();
  const lines = ['workbench 플러그인이 이 세션에 켜져 있다.'];
  if (data) {
    lines.push(`- workbench 문서 저장소(작업 보드 이슈 \`board/tasks/{task_id}.md\`와 기록 문서 \`records/\`): ${toPosix(data)}`);
    const keys = taskIdKeys(path.join(data, 'projects.tsv'));
    if (keys.length) lines.push(`- task_id 형식은 \`{접두사}-{번호}\`이고 접두사는 ${keys.map((k) => `\`${k}\``).join(', ')}다. 사용자가 이 형식의 이슈를 언급하면 workbench 보드 이슈다.`);
  } else {
    lines.push('- 이 PC의 workbench 문서 저장소 위치가 아직 정해지지 않았다. 사용자가 workbench를 쓰려 하면 먼저 `workbench:setup` 스킬로 구성한다(기존 문서 저장소에 합류하거나 새로 만든다). clone 경로만 알면 `wb config set data-root <경로>`로 위치만 정해도 된다.');
  }
  lines.push(
    '- `wb` 명령이 PATH에 있다(이 세션의 셸에만 있고, 사용자의 터미널에는 없을 수 있다). 이슈 조회·발급·이동, 기록 생성·링크, 검사, 커밋, 보드를 이 명령으로 한다. 사용자가 보드를 보려 하면 `wb board --open`(백그라운드로 뜨고 바로 돌아온다), 끄려면 `wb board --stop`. 사용법은 `wb --help`, 명령별로 `wb <명령> --help`.',
    `- 보드 이슈를 읽거나 그 이슈로 작업하거나 \`wb\`를 실행하기 전에 읽는 규칙 문서: ${toPosix(rules)}`,
    `- 보드·기록 파일 형식(필드, 상태 규칙, 설정, lint)의 정본: ${toPosix(formatSpec)}`,
    '- 이슈 발급·수정·보관과 기록 작성 절차는 `workbench:*` 스킬에 있다.',
  );

  if (data && userConfig().boardAutostart === true) {
    try {
      const line = autostartBoard(pluginRoot);
      if (line) lines.push(line);
    } catch { /* 보드를 못 띄워도 세션은 그대로 시작한다 */ }
  }

  process.stdout.write(lines.join('\n') + '\n');
} catch {
  // 안내를 싣지 못해도 세션은 그대로 시작한다
}
process.exit(0);

/** PC별 설정. 못 읽으면 빈 설정 */
function userConfig() {
  try {
    const dir = process.env.WORKBENCH_CONFIG_DIR || path.join(os.homedir(), '.workbench');
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 이 세션을 기록하고 보드를 백그라운드로 띄운다(이미 떠 있으면 wb가 아무것도 하지 않는다). 안내 한 줄, 띄우지 않았으면 null */
function autostartBoard(pluginRoot) {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* 입력 없이 실행됨 */ }
  const claude = findClaudeProcess();
  if (claude && isHeadless(claude.cmd) && !process.env.WORKBENCH_BOARD_AUTOSTART_HEADLESS) return null;
  registerSession({ sessionId: input.session_id || `pid-${claude?.pid ?? process.ppid}`, pid: claude?.pid });
  spawn(process.execPath, [path.join(pluginRoot, 'bin', 'wb.mjs'), 'board', '--auto'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return '- 로컬 보드를 자동으로 띄운다(PC별 설정 board-autostart). 처음 띄울 때만 브라우저가 열리고, 이 PC의 Claude Code 세션이 모두 끝나면 꺼진다. 주소는 `wb board`, 지금 끄려면 `wb board --stop`.';
}

/** 문서 저장소 위치. board/ 폴더가 있어야 문서 저장소로 본다. 못 찾으면 null */
function dataRoot() {
  const root = process.env.WORKBENCH_ROOT || userConfig().dataRoot || null;
  return root && fs.existsSync(path.join(root, 'board')) ? path.resolve(root) : null;
}

// projects.tsv의 key 열(주석 줄 제외)을 중복 없이 모은다. 읽지 못하면 빈 목록
function taskIdKeys(file) {
  try {
    const keys = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.split('\t')[1]?.trim())
      .filter((key) => key && key !== '-');
    return [...new Set(keys)];
  } catch {
    return [];
  }
}
