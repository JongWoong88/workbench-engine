// 보드 자동 실행(PC별 설정 boardAutostart)의 세션 기록. 세션 훅과 보드 서버(cli/board.mjs)가 함께 쓴다.
//   세션 하나 = ~/.workbench/board-sessions/<session_id>.json { sessionId, pid, startedAt }
//   pid는 그 세션의 Claude Code 프로세스다. 훅의 부모가 아닐 수 있어(nvm 같은 node shim이 끼어든다) 조상을 거슬러 찾는다.
//   보드 서버는 기록된 pid가 살아 있는지 주기적으로 본다. 그래서 종료 훅이 돌지 못하고 터미널이 닫혀도 세션이 끝난 것을 안다.
//   pid를 찾지 못한 세션은 종료 훅이 지울 때까지, 그래도 남으면 STALE_MS 동안 살아 있는 것으로 본다.
//   Node 내장 모듈만 쓴다(설치물 규칙). 어떤 함수도 예외로 세션을 막지 않게 부르는 쪽이 try로 감싼다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const STALE_MS = 24 * 60 * 60 * 1000;

export const configDir = () => path.resolve(process.env.WORKBENCH_CONFIG_DIR || path.join(os.homedir(), '.workbench'));
export const sessionsDir = (dir = configDir()) => path.join(dir, 'board-sessions');
const fileOf = (dir, sessionId) => path.join(sessionsDir(dir), `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'}.json`);

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function registerSession({ sessionId, pid }, dir = configDir()) {
  fs.mkdirSync(sessionsDir(dir), { recursive: true });
  fs.writeFileSync(fileOf(dir, sessionId), `${JSON.stringify({ sessionId, pid: Number.isInteger(pid) ? pid : null, startedAt: new Date().toISOString() })}\n`);
}

export function removeSession(sessionId, dir = configDir()) {
  fs.rmSync(fileOf(dir, sessionId), { force: true });
}

/** 살아 있는 세션 수. 끝난 세션(프로세스가 없거나 오래된 pid 없는 기록)의 파일은 지운다 */
export function liveSessionCount(dir = configDir(), now = Date.now()) {
  let names;
  try { names = fs.readdirSync(sessionsDir(dir)).filter((n) => n.endsWith('.json')); } catch { return 0; }
  let live = 0;
  for (const n of names) {
    const file = path.join(sessionsDir(dir), n);
    let s = null;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 깨진 기록 */ }
    const alive = s && (Number.isInteger(s.pid) ? pidAlive(s.pid) : now - Date.parse(s.startedAt) < STALE_MS);
    if (alive) live++;
    else fs.rmSync(file, { force: true });
  }
  return live;
}

/** 프로세스 표: pid → { ppid, name, cmd }. 못 읽으면 빈 표 */
export function processTable() {
  const rows = new Map();
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)" }';
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 6000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const [pid, ppid, name, ...cmd] = line.split('\t');
      if (/^\d+$/.test(pid)) rows.set(Number(pid), { ppid: Number(ppid), name: name ?? '', cmd: cmd.join('\t') });
    }
  } else {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024 });
    for (const line of (r.stdout || '').split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), name: path.basename(m[3].split(/\s+/)[0] ?? ''), cmd: m[3] });
    }
  }
  return rows;
}

export const isClaudeProcess = (p) => /^claude(\.exe)?$/i.test(p.name) || /@anthropic-ai[\\/]+claude-code[\\/]/i.test(p.cmd ?? '');

/** 비대화형 실행(claude -p, SDK). 이런 세션에는 보드를 띄우지 않는다 */
export const isHeadless = (cmd = '') => /(^|\s)(-p|--print|--output-format|--input-format)(?=\s|=|$)/.test(cmd);

/** 이 프로세스의 조상 중 Claude Code 프로세스. 못 찾으면 null */
export function findClaudeProcess(start = process.ppid, table = processTable()) {
  let pid = start;
  for (let i = 0; i < 10 && table.has(pid); i++) {
    const p = table.get(pid);
    if (isClaudeProcess(p)) return { pid, ...p };
    if (!p.ppid || p.ppid === pid) break;
    pid = p.ppid;
  }
  return null;
}
