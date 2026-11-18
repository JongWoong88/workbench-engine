// 단계 진입 가드(PC별 설정 stage-entry-guard): 설정, 판정 규칙 G-1~G-6, 진입 표시, 회수, 측정 기록, 실패 시 통과
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, boardTask } from './fixture.mjs';
import { judge, findTaskId, columnOrder, readColumn, readInput, run, markFile, eventsFile, guardDir, sweepStale, addMark, removeMarks, STALE_MS } from '../plugin/hooks/stage-entry-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WB = path.join(ROOT, 'plugin', 'bin', 'wb.mjs');
const GUARD = path.join(ROOT, 'plugin', 'hooks', 'stage-entry-guard.mjs');
const END_HOOK = path.join(ROOT, 'plugin', 'hooks', 'session-end.mjs');
const BOARD = path.join(ROOT, 'plugin', 'board.yml');
const COLS = columnOrder(fs.readFileSync(BOARD, 'utf8'));

let fx;
let cfg;
beforeEach(() => { fx = makeWorkspace(); cfg = path.join(fx.ws, '.wb-config'); fs.mkdirSync(cfg, { recursive: true }); });
afterEach(() => fx.cleanup());

const env = (extra = {}) => ({ ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: cfg, ...extra });
const wbConfig = (...a) => spawnSync(process.execPath, [WB, 'config', ...a, '--json'], { env: env(), encoding: 'utf8' });
const on = (extra = {}) => fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ dataRoot: fx.wb, stageEntryGuard: true, ...extra }));
const tool = (skill, args = '', session = 's-1') => ({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Skill', tool_input: { skill, args } });
const slash = (name, args = '', session = 's-1') => ({ hook_event_name: 'UserPromptExpansion', session_id: session, expansion_type: 'slash_command', command_name: name, command_args: args, prompt: `/${name} ${args}` });
const runIn = (input) => run(input, { dir: cfg, conf: { dataRoot: fx.wb, stageEntryGuard: true }, boardFile: BOARD });
const events = () => (fs.existsSync(eventsFile(cfg)) ? fs.readFileSync(eventsFile(cfg), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const spawnGuard = (input, raw) => spawnSync(process.execPath, [GUARD], { env: env({ WORKBENCH_ROOT: undefined, WORKBENCH_BOARD_FILE: BOARD }), input: raw ?? JSON.stringify(input), encoding: 'utf8', timeout: 20000 });
const setColumn = (id, column) => fx.write(`board/tasks/${id}.md`, boardTask({ id, title: `${id} task`, column }));

// ---- 설정 ----

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

// ---- 판정 ----

test('판정 보조: task_id 찾기, 컬럼 순서·값 읽기, 입력 읽기', () => {
  assert.equal(findTaskId('KEYA-12 조사 KEYB-3', ['KEYA', 'KEYB']), 'KEYA-12');
  assert.equal(findTaskId('작업명: KEYB-3 제목', ['KEYA', 'KEYB']), 'KEYB-3');
  assert.equal(findTaskId('XKEYA-1 KEYA-12a', ['KEYA']), null);
  assert.equal(findTaskId('KEYA-1', []), null);
  assert.deepEqual(COLS.slice(0, 3), ['backlog', 'on-hold', 'discovery']);
  assert.ok(COLS.indexOf('in-progress') > COLS.indexOf('planning'));
  assert.deepEqual(columnOrder('columns:\n  - {id: backlog, label: x}\n  - {id: in-progress}\nviews:\n  - id: v1\n'), ['backlog', 'in-progress']);
  assert.deepEqual(columnOrder('broken: [\n'), []);
  assert.equal(readColumn(boardTask({ id: 'KEYA-1', title: 't', column: 'design' })), 'design');
  assert.equal(readColumn('본문만'), null);
  assert.deepEqual(readInput(tool('workbench:plan', 'x')), { via: 'tool', event: 'PreToolUse', skill: 'workbench:plan', args: 'x' });
  assert.equal(readInput({ hook_event_name: 'PreToolUse', tool_input: {} }).missing, true);
  assert.equal(readInput({ hook_event_name: 'SessionStart' }), null);
});

test('판정 G-1~G-6', () => {
  const base = { taskId: 'KEYA-1', taskExists: true, column: 'backlog', columns: COLS, marks: [] };
  assert.deepEqual(judge({ ...base, skill: 'workbench:orchestrate' }), { result: 'mark', rule: 'G-1', mark: 'KEYA-1' });
  assert.equal(judge({ ...base, skill: 'workbench:orchestrate', taskId: null }).mark, '*');
  assert.equal(judge({ ...base, skill: 'workbench:new-task' }).rule, 'G-2');
  assert.equal(judge({ ...base, skill: 'groundwork' }).rule, 'G-2', '접두 없는 이름은 다른 플러그인 스킬일 수 있다');
  assert.equal(judge({ ...base, skill: 'workbench:groundwork', taskId: null }).rule, 'G-3');
  assert.equal(judge({ ...base, skill: 'workbench:groundwork', taskExists: false }).rule, 'G-3');
  for (const column of ['in-progress', 'done', 'dropped']) assert.deepEqual(judge({ ...base, skill: 'workbench:plan', column }), { result: 'pass', rule: 'G-4' });
  assert.deepEqual(judge({ ...base, skill: 'workbench:plan', column: 'nope' }), { result: 'pass', rule: 'G-4', error: 'unknown-column' });
  assert.deepEqual(judge({ ...base, skill: 'workbench:plan', columns: [] }), { result: 'pass', rule: 'G-4', error: 'unknown-column' });
  assert.equal(judge({ ...base, skill: 'workbench:groundwork', marks: ['KEYA-1'] }).rule, 'G-5');
  assert.equal(judge({ ...base, skill: 'workbench:groundwork', marks: ['*'] }).rule, 'G-5');
  for (const column of ['backlog', 'on-hold', 'discovery', 'proposal', 'design', 'planning']) {
    assert.deepEqual(judge({ ...base, skill: 'workbench:groundwork', column, marks: ['KEYA-9'] }), { result: 'deny', rule: 'G-6' });
  }
});

// ---- 가드 한 번(run) ----

test('가드: orchestrate 진입 뒤 같은 세션의 단계 스킬은 통과, 다른 세션은 막힌다', () => {
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-1 조사 주제 --자율'))?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runIn(tool('workbench:orchestrate', 'KEYA-1')), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(markFile('s-1', cfg), 'utf8')).tasks, ['KEYA-1']);
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-1 조사 주제 --자율')), null);
  assert.equal(runIn(tool('workbench:plan', '작업명: KEYA-1 Alpha task --자율')), null);
  assert.equal(runIn(tool('workbench:plan', '작업명: KEYA-1 Alpha task', 's-2'))?.hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(events().map((e) => [e.session, e.result, e.rule]), [['s-1', 'deny', 'G-6'], ['s-1', 'mark', 'G-1'], ['s-1', 'pass', 'G-5'], ['s-1', 'pass', 'G-5'], ['s-2', 'deny', 'G-6']]);
});

test('가드: 막을 때 이벤트별 출력과 사유', () => {
  const t = runIn(tool('workbench:groundwork', 'KEYA-1 조사'));
  assert.equal(t.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(t.hookSpecificOutput.permissionDecisionReason, /\/workbench:orchestrate KEYA-1/);
  assert.match(t.hookSpecificOutput.permissionDecisionReason, /사용자에게 다시 묻지 않고/);
  const s = runIn(slash('workbench:groundwork', 'KEYA-1 조사'));
  assert.equal(s.decision, 'block');
  assert.match(s.reason, /\/workbench:orchestrate KEYA-1/);
  assert.match(s.reason, /stage-entry-guard off/);
});

test('가드: 사용자 직접 입력한 orchestrate도 표시를 남기고, task_id 없이 부르면 세션 전체를 연다', () => {
  assert.equal(runIn(slash('workbench:orchestrate', 'Alpha task 계획까지')), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(markFile('s-1', cfg), 'utf8')).tasks, ['*']);
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-1 조사')), null);
  assert.equal(events().at(-1).rule, 'G-5');
});

test('가드: task_id 없음·보드에 없는 이슈·in-progress 이후는 통과, 다른 스킬은 기록하지 않는다', () => {
  assert.equal(runIn(tool('workbench:groundwork', 'alpha 조사 이슈 없는 기록')), null);
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-99 조사')), null);
  setColumn('KEYA-1', 'in-progress');
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-1 회고')), null);
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-2 조사')), null, 'done 이슈');
  assert.equal(runIn(tool('workbench:new-task', 'KEYA-1')), null);
  assert.equal(runIn(tool('code-review', 'KEYA-1')), null);
  assert.deepEqual(events().map((e) => e.rule), ['G-3', 'G-3', 'G-4', 'G-4']);
});

test('가드: 측정 기록에 인자 원문을 남기지 않는다', () => {
  runIn(tool('workbench:groundwork', 'KEYA-1 비밀 요구사항 원문'));
  assert.doesNotMatch(fs.readFileSync(eventsFile(cfg), 'utf8'), /비밀 요구사항/);
});

test('가드: 깨진 표시·board.yml·필수 필드 누락은 통과와 error 기록', () => {
  fs.mkdirSync(guardDir(cfg), { recursive: true });
  fs.writeFileSync(markFile('s-1', cfg), '{깨짐');
  assert.equal(runIn(tool('workbench:groundwork', 'KEYA-1 조사')), null);
  assert.equal(events().at(-1).error, 'broken-mark');
  fs.rmSync(markFile('s-1', cfg));
  const conf = { dataRoot: fx.wb, stageEntryGuard: true };
  const broken = path.join(fx.ws, 'broken.yml');
  fs.writeFileSync(broken, 'columns: [\n');
  assert.equal(run(tool('workbench:groundwork', 'KEYA-1 조사'), { dir: cfg, conf, boardFile: broken }), null);
  assert.equal(events().at(-1).error, 'unknown-column');
  assert.equal(run(tool('workbench:groundwork', 'KEYA-1 조사'), { dir: cfg, conf, boardFile: path.join(fx.ws, 'none.yml') }), null);
  assert.equal(events().at(-1).error, 'exception');
  assert.equal(runIn({ hook_event_name: 'PreToolUse', session_id: 's-1', tool_input: {} }), null);
  assert.equal(runIn({ hook_event_name: 'PreToolUse', tool_input: { skill: 'workbench:plan', args: 'KEYA-1' } }), null);
  assert.deepEqual(events().slice(-2).map((e) => e.error), ['missing-field', 'missing-field']);
});

test('가드: 표시 파일 이름은 세션 ID를 정규화해 설정 폴더 안에 둔다', () => {
  addMark('../../evil id', 'KEYA-1', cfg);
  const file = markFile('../../evil id', cfg);
  assert.equal(path.dirname(file), guardDir(cfg));
  assert.ok(fs.existsSync(file));
  removeMarks('../../evil id', cfg);
  assert.ok(!fs.existsSync(file));
});

test('가드: 24시간 넘은 표시 파일을 지우고 events.jsonl은 남긴다', () => {
  addMark('old', 'KEYA-1', cfg);
  addMark('new', 'KEYA-1', cfg);
  fs.appendFileSync(eventsFile(cfg), '{}\n');
  const past = (Date.now() - STALE_MS - 60000) / 1000;
  fs.utimesSync(markFile('old', cfg), past, past);
  fs.utimesSync(eventsFile(cfg), past, past);
  sweepStale(cfg);
  assert.ok(!fs.existsSync(markFile('old', cfg)));
  assert.ok(fs.existsSync(markFile('new', cfg)));
  assert.ok(fs.existsSync(eventsFile(cfg)));
});

// ---- 프로세스 ----

test('가드 프로세스: off면 출력 없이 0이고 파일을 만들지 않는다', () => {
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ dataRoot: fx.wb }));
  const r = spawnGuard(tool('workbench:groundwork', 'KEYA-1 조사'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.ok(!fs.existsSync(guardDir(cfg)));
});

test('가드 프로세스: on이면 막을 때 JSON을 출력하고, 비었거나 깨진 입력은 0으로 끝낸다', () => {
  on();
  const r = spawnGuard(tool('workbench:groundwork', 'KEYA-1 조사'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  for (const raw of ['', '{깨짐']) {
    const x = spawnGuard(null, raw);
    assert.equal(x.status, 0, x.stderr);
    assert.equal(x.stdout, '');
  }
});

test('세션 종료 훅: 그 세션의 진입 표시를 지운다', () => {
  on();
  addMark('end-1', 'KEYA-1', cfg);
  const r = spawnSync(process.execPath, [END_HOOK], { env: env(), input: JSON.stringify({ session_id: 'end-1', reason: 'exit' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(markFile('end-1', cfg)));
});

test('훅은 plugin/cli/를 가져오지 않는다(게시 패키지에서 hooks/만 복사된다)', () => {
  const dir = path.join(ROOT, 'plugin', 'hooks');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.mjs'));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /from ['"][^'"]*\/cli\//, String(f));
});
