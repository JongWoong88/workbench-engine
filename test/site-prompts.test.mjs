// 스킬 프롬프트 템플릿과 복사 버튼 노출 판정(site/src/prompts.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prompts, moveOptions, promptActions, SKILLS } from '../site/src/prompts.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = {
  columns: [
    { id: 'backlog', label: 'Backlog', state: 'waiting' },
    { id: 'doing', label: 'Doing', state: 'active' },
    { id: 'review', label: 'Review', state: 'active' },
    { id: 'done', label: 'Done', state: 'closed' },
    { id: 'dropped', label: 'Dropped', state: 'closed' },
  ],
};
const lookup = (tasks) => (id) => tasks.find((t) => t.task_id === id);

test('템플릿: 값을 그대로 끼워 넣고 끝에 줄바꿈이 없다', () => {
  assert.equal(prompts.move('K-1', 'review'), '/workbench:update-task K-1 review');
  assert.equal(prompts.drop('K-1'), '/workbench:update-task K-1 dropped');
  assert.equal(prompts.archive('K-1'), '/workbench:archive-task K-1');
  assert.equal(prompts.restore('K-1'), '/workbench:archive-task K-1 --restore');
  assert.equal(prompts.create('환불 버그'), '/workbench:new-task 환불 버그');
});

test('생성 입력: 앞뒤 공백만 걷고 줄바꿈·특수 문자는 바꾸지 않는다. 비면 null', () => {
  assert.equal(prompts.create('  \n제목\n\n- 본문 "인용" $1 #태그 `코드`\n  '), '/workbench:new-task 제목\n\n- 본문 "인용" $1 #태그 `코드`');
  assert.equal(prompts.create(''), null);
  assert.equal(prompts.create(' \n\t '), null);
  assert.equal(prompts.create(undefined), null);
});

test('이동 옵션: 종료 컬럼과 현재 컬럼을 빼고 보드 순서대로', () => {
  const ids = (t) => moveOptions(BOARD, t).map((c) => c.id);
  assert.deepEqual(ids({ column: 'backlog' }), ['doing', 'review']);
  assert.deepEqual(ids({ column: 'doing' }), ['backlog', 'review']);
  assert.deepEqual(ids({ column: 'done' }), ['backlog', 'doing', 'review']);
  assert.deepEqual(ids({ column: 'dropped' }), ['backlog', 'doing', 'review']);
});

test('노출 판정: 대기·진행·done·dropped·보관됨', () => {
  const none = lookup([]);
  const pick = ({ move, drop, archive, restore }) => ({ move, drop, archive, restore });
  assert.deepEqual(pick(promptActions({ column: 'backlog' }, BOARD, none)), { move: true, drop: true, archive: false, restore: false });
  assert.deepEqual(pick(promptActions({ column: 'doing' }, BOARD, none)), { move: true, drop: true, archive: false, restore: false });
  assert.deepEqual(pick(promptActions({ column: 'done' }, BOARD, none)), { move: true, drop: true, archive: true, restore: false });
  assert.deepEqual(pick(promptActions({ column: 'dropped' }, BOARD, none)), { move: true, drop: false, archive: true, restore: false });
  assert.deepEqual(pick(promptActions({ column: 'done', archived: true }, BOARD, none)), { move: false, drop: false, archive: false, restore: true });
});

test('노출 판정: 끝나지 않은 하위 이슈 수, 보드에 dropped가 없으면 폐기 숨김', () => {
  const tasks = [{ task_id: 'K-2', closed: false }, { task_id: 'K-3', closed: true }, { task_id: 'K-4', closed: false }];
  assert.equal(promptActions({ column: 'doing', children: ['K-2', 'K-3', 'K-4', 'K-9'] }, BOARD, lookup(tasks)).openChildren, 2);
  assert.equal(promptActions({ column: 'doing', children: ['K-3'] }, BOARD, lookup(tasks)).openChildren, 0);
  const noDrop = { columns: BOARD.columns.filter((c) => c.id !== 'dropped') };
  assert.equal(promptActions({ column: 'doing' }, noDrop, lookup([])).drop, false);
});

test('템플릿이 부르는 스킬 파일이 있다(이름만 확인한다)', () => {
  for (const name of SKILLS) assert.ok(fs.existsSync(path.join(ROOT, 'plugin', 'skills', name, 'SKILL.md')), `plugin/skills/${name}/SKILL.md가 없다`);
});
