// 보드 데이터 모델(bin/lib/board.mjs): board.yml 검증, task 파일 읽기·쓰기, 상태 전이
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoard, parseTaskText, stringifyTask, planMove, planArchive, newTaskData } from '../plugin/cli/lib/board.mjs';
import { Rejection } from '../plugin/cli/lib/report.mjs';

const BOARD_YML = `columns:
  - {id: backlog, label: 📋 Backlog, state: waiting, color: '#8a9099'}
  - {id: on-hold, label: 🧊 On Hold, state: waiting}
  - {id: discovery, label: 🔍 Discovery, state: active}
  - {id: design, label: 📐 Design, state: active}
  - {id: done, label: ✅ Done, state: closed}
  - {id: dropped, label: 🗑️ Dropped, state: closed}
views:
  - {id: progress, label: 진행 현황, columns: [backlog, discovery, design]}
description: 워크플로 설명
`;
const board = parseBoard(BOARD_YML);
const NOW = '2026-10-29T00:00:00.000Z';
const T0 = '2026-10-01T00:00:00.000Z';

const task = (data) => ({ data: { task_id: 'KEYA-1', title: 'A', project: 'alpha', type: 'feature', created: T0, history: [], ...data } });
const move = (data, to, opts = {}) => planMove(task(data), to, board, { now: NOW, author: 'tester', ...opts });
const rejects = (fn, code) => assert.throws(fn, (e) => e instanceof Rejection && e.code === code);

test('board.yml: 컬럼·뷰·기본값을 읽는다', () => {
  assert.deepEqual(board.columns.map((c) => c.id), ['backlog', 'on-hold', 'discovery', 'design', 'done', 'dropped']);
  assert.equal(board.byId.get('design').state, 'active');
  assert.equal(board.byLabel.get('✅ Done').id, 'done');
});

test('board.yml: 형식 위반은 BOARD-CONFIG로 거부한다', () => {
  rejects(() => parseBoard('columns:\n  - {id: a, label: A, state: waiting}\n  - {id: a, label: B, state: active}\n'), 'BOARD-CONFIG');
  rejects(() => parseBoard('columns:\n  - {id: a, label: A, state: started}\n'), 'BOARD-CONFIG');
  rejects(() => parseBoard('columns:\n  - {id: a, label: A, state: waiting}\nviews:\n  - {id: v, label: V, columns: [a, b]}\n'), 'BOARD-CONFIG');
  rejects(() => parseBoard('columns: [\n'), 'BOARD-CONFIG');
});

test('생성: 대기 컬럼이면 날짜를 채우지 않고, 진행 컬럼이면 started를 채운다', () => {
  const w = newTaskData({ task_id: 'KEYA-1', title: 'A', project: 'alpha', type: 'feature', column: 'backlog', author: 'tester', assigned: 'tester', now: NOW }, board);
  assert.equal(w.started, undefined);
  assert.equal(w.completed, undefined);
  assert.deepEqual(w.history, [{ type: 'created', date: NOW, author: 'tester', column: 'backlog' }]);
  const a = newTaskData({ task_id: 'KEYA-1', title: 'A', project: 'alpha', type: 'feature', column: 'discovery', author: 'tester', assigned: 'tester', now: NOW }, board);
  assert.equal(a.started, NOW);
  rejects(() => newTaskData({ task_id: 'KEYA-1', title: 'A', project: 'alpha', type: 'feature', column: 'nope', now: NOW }, board), 'COLUMN-UNKNOWN');
});

test('생성: 작성자는 author 필드와 created 이력에, 담당은 assigned에만 쓴다', () => {
  const w = newTaskData({ task_id: 'KEYA-1', title: 'A', project: 'alpha', type: 'feature', column: 'backlog', author: 'writer', assigned: 'owner', now: NOW }, board);
  assert.equal(w.author, 'writer');
  assert.equal(w.assigned, 'owner');
  assert.equal(w.history[0].author, 'writer');
  assert.match(stringifyTask(w, ''), /^column: backlog\nauthor: writer\nassigned: owner$/m);
});

test('이동·보관은 author를 그대로 둔다', () => {
  assert.equal(move({ column: 'backlog', author: 'writer' }, 'design').data.author, 'writer');
  assert.equal(planArchive(task({ column: 'done', author: 'writer' }), board, { now: NOW, author: 'tester' }).data.author, 'writer');
});

test('S-1: 대기 → 진행은 started를 채우고, 이미 있으면 두지 않는다', () => {
  assert.equal(move({ column: 'backlog' }, 'discovery').data.started, NOW);
  assert.equal(move({ column: 'on-hold', started: T0 }, 'design').data.started, T0);
});

test('진행 → 대기(보류)는 날짜를 바꾸지 않는다', () => {
  const r = move({ column: 'design', started: T0 }, 'on-hold');
  assert.equal(r.data.started, T0);
  assert.equal(r.data.completed, undefined);
});

test('S-2a: 대기·진행 → 종료는 completed를 채운다', () => {
  const w = move({ column: 'backlog' }, 'dropped');
  assert.equal(w.data.completed, NOW);
  assert.equal(w.data.started, undefined);
  assert.equal(move({ column: 'design', started: T0 }, 'done').data.completed, NOW);
});

test('S-2b: 종료 → 대기·진행은 completed를 지우고, 진행이면 S-1도 적용한다', () => {
  const w = move({ column: 'done', started: T0, completed: T0 }, 'backlog');
  assert.equal('completed' in w.data, false);
  const a = move({ column: 'dropped', completed: T0 }, 'design');
  assert.equal('completed' in a.data, false);
  assert.equal(a.data.started, NOW);
});

test('같은 상태 안 이동은 날짜를 바꾸지 않는다', () => {
  const a = move({ column: 'discovery', started: T0 }, 'design');
  assert.equal(a.data.started, T0);
  const c = move({ column: 'done', started: T0, completed: T0 }, 'dropped');
  assert.equal(c.data.completed, T0);
});

test('이동은 history에 한 줄을 덧붙이고, 같은 컬럼이면 바꾸지 않는다', () => {
  const r = move({ column: 'backlog', history: [{ type: 'created', date: T0, author: 'tester', column: 'backlog' }] }, 'design');
  assert.equal(r.data.column, 'design');
  assert.deepEqual(r.data.history.at(-1), { type: 'moved', date: NOW, author: 'tester', from: 'backlog', to: 'design' });
  assert.equal(r.data.history.length, 2);
  assert.equal(move({ column: 'design' }, 'design').changed, false);
  rejects(() => move({ column: 'design' }, 'nope'), 'COLUMN-UNKNOWN');
});

test('S-3: 끝나지 않은 child가 있으면 종료를 거부하고, force면 옮긴다', () => {
  const children = [{ data: { task_id: 'KEYA-2', column: 'design' } }, { data: { task_id: 'KEYA-3', column: 'done' } }];
  rejects(() => move({ column: 'design' }, 'done', { children }), 'TASK-OPEN-CHILDREN');
  assert.equal(move({ column: 'design' }, 'done', { children, force: true }).data.column, 'done');
  assert.equal(move({ column: 'design' }, 'done', { children: [children[1]] }).data.column, 'done');
});

test('보관: 종료 이슈만 보관하고, 꺼내면 표시를 지우며, 보관된 이슈는 옮길 수 없다', () => {
  const done = task({ column: 'done', completed: T0 });
  const a = planArchive(done, board, { now: NOW, author: 'tester' });
  assert.equal(a.data.archived, true);
  assert.deepEqual(a.data.history.at(-1), { type: 'archived', date: NOW, author: 'tester' });
  assert.equal(planArchive({ data: a.data }, board, { now: NOW, author: 'tester' }).changed, false);
  rejects(() => planArchive(task({ column: 'design' }), board, { now: NOW, author: 'tester' }), 'TASK-NOT-CLOSED');
  rejects(() => planMove({ data: a.data }, 'design', board, { now: NOW, author: 'tester' }), 'TASK-ARCHIVED');
  const r = planArchive({ data: a.data }, board, { now: NOW, author: 'tester', restore: true });
  assert.equal('archived' in r.data, false);
  assert.equal(r.entry.type, 'restored');
  assert.equal(planArchive(done, board, { now: NOW, author: 'tester', restore: true }).changed, false);
  assert.match(stringifyTask(a.data, ''), /^archived: true$/m);
  assert.doesNotMatch(stringifyTask({ ...a.data, archived: false }, ''), /^archived:/m);
});

test('task 파일: 시각은 따옴표로 쓰고, 쓰기 → 읽기 → 쓰기가 같다', () => {
  const data = {
    task_id: 'KEYA-1', title: 'A: 제목 #1', project: 'alpha', type: 'feature', column: 'design', author: 'tester', assigned: 'tester',
    created: T0, started: NOW, parent: 'KEYA-0',
    outputs: [{ kind: '설계', path: 'records/alpha/KEYA-1/design.md', desc: '구조 — 결정 2건' }],
    history: [{ type: 'created', date: T0, author: 'tester', column: 'backlog' }, { type: 'moved', date: NOW, author: 'tester', from: 'backlog', to: 'design' }],
  };
  const text = stringifyTask(data, '설명 본문\n');
  assert.match(text, /^created: '2026-10-01T00:00:00\.000Z'$/m);
  assert.match(text, /^    date: '2026-10-29T00:00:00\.000Z'$/m);
  assert.match(text, /^title: 'A: 제목 #1'$/m);
  const parsed = parseTaskText(text);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, '설명 본문\n');
  assert.equal(stringifyTask(parsed.data, parsed.body), text);
});

test('task 파일: 필드 순서를 고정하고 빈 값은 쓰지 않는다', () => {
  const text = stringifyTask({ history: [], column: 'backlog', title: 'A', task_id: 'KEYA-1', project: 'alpha', type: 'feature', created: T0, completed: null, outputs: [] }, '');
  assert.deepEqual([...text.matchAll(/^(\w+):/gm)].map((m) => m[1]), ['task_id', 'title', 'project', 'type', 'column', 'created', 'history']);
  assert.match(text, /^history: \[\]$/m);
});

test('task 파일: 프론트매터가 없거나 깨졌으면 error를 돌려준다', () => {
  assert.ok(parseTaskText('# 제목만\n').error);
  assert.ok(parseTaskText('---\ntitle: [\n---\n').error);
});

test('작업 공간 로더: 목록·상태·children·요약, 깨진 파일은 error로', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadBoardTasks, summarizeBoardTask } = await import('../plugin/cli/lib/board.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-board-'));
  try {
    const dir = path.join(root, 'tasks');
    fs.mkdirSync(dir);
    fs.mkdirSync(path.join(root, 'records', 'alpha', 'KEYA-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'records', 'alpha', 'KEYA-1', 'plan.md'), '# p\n');
    const write = (id, data) => fs.writeFileSync(path.join(dir, `${id}.md`), stringifyTask({ task_id: id, title: id, project: 'alpha', type: 'feature', created: T0, history: [], ...data }, ''));
    write('KEYA-1', { column: 'design', started: T0 });
    write('KEYA-2', { column: 'done', parent: 'KEYA-1', completed: NOW });
    fs.writeFileSync(path.join(dir, 'KEYA-3.md'), '# 프론트매터 없음\n');
    const tasks = loadBoardTasks(board, dir);
    assert.deepEqual(tasks.map((t) => [t.name, t.state, t.closed]), [['KEYA-1', 'active', false], ['KEYA-2', 'closed', true], ['KEYA-3', null, false]]);
    assert.ok(tasks[2].error);
    const s = summarizeBoardTask(tasks[0], board, path.join(root, 'records'));
    assert.equal(s.column, 'design');
    assert.equal(s.columnLabel, '📐 Design');
    assert.deepEqual(s.children, ['KEYA-2']);
    assert.equal(s.recordsDirExists, true);
    assert.equal(s.records.length, 1);
    assert.equal(summarizeBoardTask(tasks[1], board).parent, 'KEYA-1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
