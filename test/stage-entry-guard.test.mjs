// 단계 진입 가드(PC별 설정 stage-entry-guard): 설정, 판정 규칙 G-1~G-6, 진입 표시, 회수, 측정 기록, 실패 시 통과
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WB = path.join(ROOT, 'plugin', 'bin', 'wb.mjs');

let fx;
let cfg;
beforeEach(() => { fx = makeWorkspace(); cfg = path.join(fx.ws, '.wb-config'); fs.mkdirSync(cfg, { recursive: true }); });
afterEach(() => fx.cleanup());

const env = (extra = {}) => ({ ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: cfg, ...extra });
const wbConfig = (...a) => spawnSync(process.execPath, [WB, 'config', ...a, '--json'], { env: env(), encoding: 'utf8' });

test('wb config stage-entry-guard: on/off/unset, 기본 off', () => {
  assert.equal(JSON.parse(wbConfig('get').stdout).stageEntryGuard, false);
  assert.equal(wbConfig('set', 'stage-entry-guard', 'on').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8')).stageEntryGuard, true);
  assert.equal(JSON.parse(wbConfig('get').stdout).stageEntryGuard, true);
  assert.equal(wbConfig('set', 'stage-entry-guard', 'yes').status, 2);
  assert.equal(wbConfig('set', 'stage-entry-guard', 'off').status, 0);
  assert.equal(JSON.parse(wbConfig('get').stdout).stageEntryGuard, false);
  assert.equal(wbConfig('unset', 'stage-entry-guard').status, 0);
  // 남은 키가 없으면 설정 파일을 지운다(lib/workbench.mjs writeUserConfig)
  const file = path.join(cfg, 'config.json');
  assert.equal(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).stageEntryGuard : undefined, undefined);
  const text = spawnSync(process.execPath, [WB, 'config', 'get'], { env: env(), encoding: 'utf8' }).stdout;
  assert.match(text, /stage-entry-guard: off \(기본값\)/);
});

test('wb config stage-entry-guard: 다른 키를 건드리지 않는다', () => {
  assert.equal(wbConfig('set', 'board-autostart', 'on').status, 0);
  assert.equal(wbConfig('set', 'stage-entry-guard', 'on').status, 0);
  const conf = JSON.parse(fs.readFileSync(path.join(cfg, 'config.json'), 'utf8'));
  assert.equal(conf.boardAutostart, true);
  assert.equal(conf.stageEntryGuard, true);
});
