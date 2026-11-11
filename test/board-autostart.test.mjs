// 보드 자동 실행(PC별 설정 board-autostart): 세션 기록, Claude Code 프로세스 찾기, 세션 훅의 보드 실행, 세션이 모두 끝나면 보드가 꺼지는 것
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, withRemote } from './fixture.mjs';
import { registerSession, removeSession, liveSessionCount, sessionsDir, findClaudeProcess, isHeadless, isClaudeProcess, STALE_MS } from '../plugin/hooks/board-sessions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WB = path.join(ROOT, 'plugin', 'bin', 'wb.mjs');
const HOOK = path.join(ROOT, 'plugin', 'hooks', 'session-context.mjs');
const END_HOOK = path.join(ROOT, 'plugin', 'hooks', 'session-end.mjs');

let fx;
let cfg;
const kill = [];
beforeEach(() => { fx = makeWorkspace(); withRemote(fx); cfg = path.join(fx.ws, '.wb-config'); fs.mkdirSync(cfg, { recursive: true }); });
afterEach(() => {
  for (const pid of kill.splice(0)) { try { process.kill(pid); } catch { /* 이미 끝났다 */ } }
  fx.cleanup();
});

const UI = () => {
  const dir = path.join(fx.ws, 'ui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>board</title>');
  return dir;
};
const env = (extra = {}) => ({
  ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: cfg, WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml'),
  WORKBENCH_BOARD_UI: UI(), WORKBENCH_BOARD_NO_BROWSER: '1', WORKBENCH_BOARD_PORT: '0',
  WORKBENCH_BOARD_SESSION_CHECK_MS: '200', WORKBENCH_BOARD_SESSION_GRACE_MS: '600', ...extra,
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(100); } return false; };
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(cfg, 'board.json'), 'utf8')); } catch { return null; } };
const answers = (port) => new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/api/head' }, (res) => { res.resume(); resolve(true); }).on('error', () => resolve(false)));
/** 살아 있는 동안 세션 역할을 하는 프로세스 */
const sessionProcess = () => { const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); kill.push(p.pid); return p; };

test('Claude Code 프로세스 판별: 이름·npm 경로, 비대화형 실행', () => {
  assert.ok(isClaudeProcess({ name: 'claude.exe', cmd: '' }));
  assert.ok(isClaudeProcess({ name: 'claude', cmd: '/usr/local/bin/claude' }));
  assert.ok(isClaudeProcess({ name: 'node', cmd: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js' }));
  assert.ok(!isClaudeProcess({ name: 'node.exe', cmd: 'node hooks/session-context.mjs' }));
  for (const c of ['claude -p "hi"', 'claude --print x', 'claude --output-format=json -p x', 'claude.exe --input-format stream-json']) assert.ok(isHeadless(c), c);
  for (const c of ['claude', 'claude --resume', 'claude --plugin-dir ./plugin', 'claude "use -prefix"']) assert.ok(!isHeadless(c), c);
});

test('Claude Code 프로세스 찾기: node shim을 건너 조상에서 찾고, 없으면 null', () => {
  const table = new Map([
    [10, { ppid: 9, name: 'node.exe', cmd: 'node hook.mjs' }], // nvm shim
    [9, { ppid: 5, name: 'claude.exe', cmd: 'claude.exe --resume' }],
    [5, { ppid: 1, name: 'bash', cmd: 'bash' }],
  ]);
  assert.equal(findClaudeProcess(10, table).pid, 9);
  assert.equal(findClaudeProcess(5, table), null);
  assert.equal(findClaudeProcess(99, table), null);
});

test('세션 기록: 끝난 프로세스와 오래된 pid 없는 기록은 지우고 살아 있는 세션만 센다', () => {
  const p = sessionProcess();
  registerSession({ sessionId: 'live', pid: p.pid }, cfg);
  registerSession({ sessionId: 'dead', pid: 2 ** 22 + 12345 }, cfg); // 없는 pid
  registerSession({ sessionId: 'nopid', pid: null }, cfg);
  registerSession({ sessionId: '../escape', pid: null }, cfg); // 파일 이름은 폴더를 벗어나지 않는다
  assert.equal(liveSessionCount(cfg), 3);
  assert.ok(!fs.readdirSync(sessionsDir(cfg)).some((n) => n.startsWith('dead')));
  assert.ok(!fs.existsSync(path.join(cfg, 'escape.json')));
  assert.equal(liveSessionCount(cfg, Date.now() + STALE_MS + 1000), 1); // pid 없는 기록은 오래되면 끝난 것으로 본다
  removeSession('live', cfg);
  assert.equal(liveSessionCount(cfg), 0);
});

test('wb board --auto: 새로 띄우고, 떠 있으면 그대로 두고, 세션이 모두 끝나면 스스로 꺼진다', async () => {
  const p = sessionProcess();
  registerSession({ sessionId: 's1', pid: p.pid }, cfg);
  const first = spawnSync(process.execPath, [WB, 'board', '--auto', '--json'], { env: env(), encoding: 'utf8', timeout: 30000 });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const out = JSON.parse(first.stdout);
  kill.push(out.pid);
  assert.equal(out.reused, false);
  assert.equal(state().auto, true);
  assert.ok(await answers(out.port));

  const again = JSON.parse(spawnSync(process.execPath, [WB, 'board', '--auto', '--json'], { env: env(), encoding: 'utf8', timeout: 30000 }).stdout);
  assert.equal(again.reused, true);
  assert.equal(again.pid, out.pid);

  await sleep(1000);
  assert.ok(alive(out.pid), '세션이 살아 있는 동안은 돈다');
  process.kill(p.pid); // 터미널을 닫은 경우: 종료 훅 없이 프로세스만 사라진다
  assert.ok(await until(() => !alive(out.pid)), '세션이 끝나면 꺼진다');
  assert.equal(state(), null);
});

test('wb board --auto: 다른 옵션과 함께 쓰지 않는다', () => {
  assert.equal(spawnSync(process.execPath, [WB, 'board', '--auto', '--open'], { env: env(), encoding: 'utf8' }).status, 2);
});

// 시험을 비대화형 Claude Code(claude -p) 안에서 돌려도 같게 동작하도록 비대화형 건너뛰기를 끈다
const runHook = (file, input) => spawnSync(process.execPath, [file], { env: env({ WORKBENCH_ROOT: undefined, WORKBENCH_BOARD_AUTOSTART_HEADLESS: '1' }), input: JSON.stringify(input), encoding: 'utf8', timeout: 20000 });

test('세션 훅: board-autostart가 켜져 있으면 세션을 기록하고 보드를 띄우며, 종료 훅이 기록을 지운다', async () => {
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ dataRoot: fx.wb, boardAutostart: true }));
  const r = runHook(HOOK, { session_id: 'abc-123', source: 'startup' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /로컬 보드를 자동으로 띄운다/);
  const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir(cfg), 'abc-123.json'), 'utf8'));
  assert.equal(rec.sessionId, 'abc-123');
  // 이 시험을 Claude Code 안에서 돌리면 그 프로세스가, 아니면 pid 없이 기록된다
  assert.ok(rec.pid === null || Number.isInteger(rec.pid));
  assert.ok(await until(() => state() !== null), '보드가 뜬다');
  kill.push(state().pid);

  assert.equal(runHook(END_HOOK, { session_id: 'abc-123', reason: 'exit' }).status, 0);
  assert.ok(!fs.existsSync(path.join(sessionsDir(cfg), 'abc-123.json')));
  assert.ok(await until(() => state() === null), '세션이 모두 끝나 보드가 꺼진다');
});

test('세션 훅: board-autostart가 꺼져 있으면 세션을 기록하지 않고 보드를 띄우지 않는다', async () => {
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ dataRoot: fx.wb }));
  const r = runHook(HOOK, { session_id: 'abc-123' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /로컬 보드/);
  assert.ok(!fs.existsSync(sessionsDir(cfg)));
  await sleep(500);
  assert.equal(state(), null);
});

test('wb config board-autostart: on/off/unset', () => {
  const wb = (...a) => spawnSync(process.execPath, [WB, 'config', ...a, '--json'], { env: env(), encoding: 'utf8' });
  assert.equal(JSON.parse(wb('get').stdout).boardAutostart, false);
  assert.equal(wb('set', 'board-autostart', 'on').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8')).boardAutostart, true);
  assert.equal(JSON.parse(wb('get').stdout).boardAutostart, true);
  assert.equal(wb('set', 'board-autostart', 'yes').status, 2);
  assert.equal(wb('unset', 'board-autostart').status, 0);
  assert.equal(JSON.parse(wb('get').stdout).boardAutostart, false);
});
