#!/usr/bin/env node
// SessionEnd hook — 끝난 세션의 기록을 지운다: 보드 자동 실행(PC별 설정 boardAutostart)의 세션 기록과
//   단계 진입 가드(stageEntryGuard)의 진입 표시. 둘은 서로의 실패를 막지 않게 따로 감싼다.
//   세션이 모두 끝나면 보드 서버가 스스로 꺼진다(cli/board.mjs). 이 훅은 그 판단을 앞당길 뿐이다.
//   터미널을 갑자기 닫으면 이 훅이 돌지 않을 수 있다 — 그때는 보드 서버가 기록된 Claude Code 프로세스가 없어진 것을 보고 끈다.
//   아무것도 출력하지 않고, 어떤 경우에도 0으로 끝낸다.
import fs from 'node:fs';
import { removeSession } from './board-sessions.mjs';
import { removeMarks } from './stage-entry-guard.mjs';

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* 입력 없이 실행됨 */ }
if (input.session_id) {
  try {
    removeSession(input.session_id);
  } catch {
    // 기록이 남아도 보드 서버가 프로세스를 보고 정리한다
  }
  try {
    removeMarks(input.session_id);
  } catch {
    // 남은 진입 표시는 가드가 24시간 뒤 지운다
  }
}
process.exit(0);
