#!/usr/bin/env node
// SessionEnd hook — 보드 자동 실행(PC별 설정 boardAutostart)에서 끝난 세션의 기록을 지운다.
//   세션이 모두 끝나면 보드 서버가 스스로 꺼진다(cli/board.mjs). 이 훅은 그 판단을 앞당길 뿐이다.
//   터미널을 갑자기 닫으면 이 훅이 돌지 않을 수 있다 — 그때는 보드 서버가 기록된 Claude Code 프로세스가 없어진 것을 보고 끈다.
//   아무것도 출력하지 않고, 어떤 경우에도 0으로 끝낸다.
import fs from 'node:fs';
import { removeSession } from './board-sessions.mjs';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (input.session_id) removeSession(input.session_id);
} catch {
  // 기록이 남아도 보드 서버가 프로세스를 보고 정리한다
}
process.exit(0);
