// 플러그인 실행 진입점 plugin/bin/wb(.cmd) → wb.mjs → clone의 bin/<명령>.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './fixture.mjs';

const PLUGIN_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'bin');
let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

/** 이 플랫폼의 진입점으로 실행한다 (Windows는 wb.cmd, 그 밖은 sh wb) */
function wb(args, env = {}) {
  const e = { ...process.env, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml'), ...env };
  const r = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${path.join(PLUGIN_BIN, 'wb.cmd')}" ${args.join(' ')}`], { encoding: 'utf8', env: e, windowsVerbatimArguments: true })
    : spawnSync('sh', [path.join(PLUGIN_BIN, 'wb'), ...args], { encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('wb: WORKBENCH_ROOT의 clone 명령을 실행한다', () => {
  const r = wb(['find-task', 'KEYA-1', '--json'], { WORKBENCH_ROOT: fx.wb });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).task.task_id, 'KEYA-1');
});

test('wb: 허용 밖 명령은 종료 코드 2', () => {
  const bad = wb(['replay-run', '--json'], { WORKBENCH_ROOT: fx.wb });
  assert.equal(bad.code, 2);
  assert.equal(JSON.parse(bad.out).code, 'WB-COMMAND');
});

test('wb --help: 문서 저장소 위치와 엔진 위치를 보여 준다', () => {
  const none = wb(['--help'], { WORKBENCH_ROOT: '' });
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /문서: \(정해지지 않음/);
  assert.ok(none.out.includes(`엔진: ${path.resolve(PLUGIN_BIN, '..')}`), none.out);
  assert.ok(wb(['--help'], { WORKBENCH_ROOT: fx.wb }).out.includes(`문서: ${fx.wb} (환경변수 WORKBENCH_ROOT)`));
});

test('wb: decision-stats도 실행한다', () => {
  const r = wb(['decision-stats', '--help'], { WORKBENCH_ROOT: fx.wb });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /decision-stats/);
});
