// 보드(board/) 데이터 모델. board.yml과 task 파일을 읽고 쓰고, 컬럼 이동 규칙(상태 전이)을 계산한다.
// 형식과 규칙의 정본: 형식 문서(references/workbench-format.md) "보드 (board/)"
import fs from 'node:fs';
import path from 'node:path';
import { WB, ENGINE, RECORDS, rel, read, exists, listFiles } from './workbench.mjs';
import { Rejection, EXIT } from './report.mjs';
// 파싱은 node: 의존이 없는 model/에 있다(보드 화면와 함께 쓴다). 여기서는 Rejection으로 감싸 다시 내보낸다
import { STATES, COLUMN_ID_RE, boardProblems, parseBoardText, parseTaskText, effectiveAuthor } from './model/board.mjs';
import { ParseError } from './model/errors.mjs';

export { STATES, COLUMN_ID_RE, boardProblems, parseTaskText };

export const BOARD = path.join(WB, 'board');
// 보드 설정(컬럼·뷰)은 엔진이 가진다(D-4). 문서 저장소에 board/board.yml이 있어도 읽지 않는다.
// WORKBENCH_BOARD_FILE은 시험과 엔진 개발에서 다른 보드 설정을 쓸 때만 준다
export const BOARD_FILE = path.resolve(process.env.WORKBENCH_BOARD_FILE || path.join(ENGINE, 'board.yml'));
/** 메시지에 쓰는 보드 설정 파일 이름 */
export const BOARD_FILE_LABEL = BOARD_FILE.startsWith(WB + path.sep) ? rel(BOARD_FILE) : 'board.yml(엔진)';
export const TASKS = path.join(BOARD, 'tasks');

// ── board.yml ──────────────────────────────────────────────
export function parseBoard(text, file = 'board/board.yml') {
  try {
    return parseBoardText(text);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    const fix = e.problems.length ? [...e.problems, '형식: 형식 문서(references/workbench-format.md) "board.yml"'] : 'YAML 문법 오류를 고친다';
    throw new Rejection({ code: e.code, file, message: e.message, fix, owner: 'board' });
  }
}

/** board.yml 내용. parseBoard가 돌려준 값(또는 같은 모양의 객체)을 결정적인 텍스트로 쓴다 */
export function stringifyBoard({ columns, views = [], description = '' }) {
  const out = ['# 보드 설정. 형식: 형식 문서(references/workbench-format.md) "board.yml"', 'columns:'];
  for (const c of columns) {
    out.push(`  - id: ${c.id}`, `    label: ${scalar(c.label)}`, `    state: ${c.state}`);
    if (c.color) out.push(`    color: ${scalar(c.color)}`);
  }
  if (views.length) {
    out.push('views:');
    for (const v of views) out.push(`  - id: ${v.id}`, `    label: ${scalar(v.label)}`, `    columns: [${v.columns.join(', ')}]`);
  }
  const desc = description.replace(/\s+$/, '');
  if (desc) out.push('description: |', ...desc.split('\n').map((l) => (l ? `  ${l}` : '')));
  return out.join('\n') + '\n';
}

export const stateOf = (board, columnId) => board.byId.get(columnId)?.state ?? null;

function requireColumn(board, id) {
  const col = board.byId.get(id);
  if (col) return col;
  const byLabel = board.byLabel.get(id);
  throw new Rejection({
    code: 'COLUMN-UNKNOWN', message: `컬럼 '${id}'가 보드에 없다`,
    fix: [byLabel ? `컬럼은 이름이 아니라 id로 쓴다: '${byLabel.id}'` : `있는 컬럼 id: ${board.columns.map((c) => c.id).join(', ')}`],
    exit: EXIT.USAGE,
  });
}

// ── task 파일 ──────────────────────────────────────────────
/** 쓰는 순서. 여기 없는 키는 뒤에 원래 순서대로 붙인다 */
export const TASK_FIELDS = ['task_id', 'title', 'project', 'type', 'column', 'author', 'assigned', 'created', 'started', 'completed', 'archived', 'parent', 'outputs', 'history'];
const DATE_FIELDS = new Set(['created', 'started', 'completed']);
const ENTRY_FIELDS = { outputs: ['kind', 'path', 'desc'], history: ['type', 'date', 'author', 'column', 'from', 'to'] };

// YAML 1.1(PyYAML)과 1.2(yaml 패키지) 어느 쪽으로 읽어도 문자열이 되도록 쓴다
const PLAIN_UNSAFE = /^[\s\-?:,[\]{}#&*!|>'"%@`]|: | #|[:\s]$|^$|^(true|false|null|yes|no|on|off|y|n|~)$|^[\d.+-]/i;
export function scalar(v, quote = false) {
  const s = String(v);
  if (/[\n\r\t\x00-\x1f]/.test(s)) return JSON.stringify(s);
  return quote || PLAIN_UNSAFE.test(s) ? `'${s.replace(/'/g, "''")}'` : s;
}
const isEmpty = (v) => v === null || v === undefined || v === '';
const ordered = (obj, order) => [...order.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !order.includes(k))];

/** task 파일 내용. 필드 순서와 따옴표 규칙이 고정이라 같은 데이터면 같은 텍스트가 나온다 */
export function stringifyTask(data, body = '') {
  const out = [];
  for (const k of ordered(data, TASK_FIELDS)) {
    const v = data[k];
    if (isEmpty(v) || v === false) continue;
    if (v === true) { out.push(`${k}: true`); continue; }
    if (!Array.isArray(v)) { out.push(`${k}: ${scalar(v, DATE_FIELDS.has(k))}`); continue; }
    if (v.length === 0) { if (k === 'history') out.push('history: []'); continue; }
    out.push(`${k}:`);
    for (const item of v) {
      if (!item || typeof item !== 'object') { out.push(`  - ${scalar(item)}`); continue; }
      ordered(item, ENTRY_FIELDS[k] ?? []).filter((x) => !isEmpty(item[x]))
        .forEach((x, i) => out.push(`${i ? '    ' : '  - '}${x}: ${scalar(item[x], x === 'date')}`));
    }
  }
  const b = String(body ?? '').replace(/^\n+/, '');
  return `---\n${out.join('\n')}\n---\n${b ? `\n${b}${b.endsWith('\n') ? '' : '\n'}` : ''}`;
}

/** task 파일을 읽는다. 형식이 깨졌으면 error에 이유를 담아 돌려준다(던지지 않는다) */

// ── 상태 전이 (design-data-model.md "상태 규칙") ─────────────
/** 새 이슈의 프론트매터. 생성 컬럼의 상태에 따라 S-1·S-2a를 적용한다. created 이력의 author는 담당이 아니라 작성자다 */
export function newTaskData({ task_id, title, project, type, column, author, assigned, now, parent }, board) {
  const { state } = requireColumn(board, column);
  const data = { task_id, title, project, type, column };
  if (author) data.author = author;
  if (assigned) data.assigned = assigned;
  data.created = now;
  if (state === 'active') data.started = now;
  if (state === 'closed') data.completed = now;
  if (parent) data.parent = parent;
  data.history = [{ type: 'created', date: now, author, column }];
  return data;
}

/**
 * 컬럼 이동 결과를 계산한다. 파일은 쓰지 않는다.
 * @returns {{changed: false} | {changed: true, data: object, entry: object}}
 */
export function planMove(task, to, board, { now, author, children = [], force = false }) {
  const dest = requireColumn(board, to).state;
  if (task.data.archived === true) {
    throw new Rejection({
      code: 'TASK-ARCHIVED', message: `${task.data.task_id}는 보관된 이슈라 옮길 수 없다`,
      fix: [`다시 진행하려면 먼저 꺼낸다: wb archive-task ${task.data.task_id} --restore`], owner: 'board',
    });
  }
  const from = task.data.column;
  if (from === to) return { changed: false };
  const fromState = stateOf(board, from);

  if (dest === 'closed' && !force) {
    const open = children.filter((c) => stateOf(board, c.data.column) !== 'closed');
    if (open.length) {
      throw new Rejection({
        code: 'TASK-OPEN-CHILDREN',
        message: `끝나지 않은 child가 ${open.length}개 있어 '${to}'로 옮길 수 없다: ${open.map((c) => `${c.data.task_id}(${c.data.column ?? '컬럼 없음'})`).join(', ')}`,
        fix: ['child를 먼저 끝내거나, child 없이 종료할지 사용자에게 확인한다', '사용자가 그대로 종료하기로 정했으면 --force를 붙여 다시 실행한다'],
        owner: 'user',
      });
    }
  }

  const data = { ...task.data, column: to };
  if (dest === 'active' && isEmpty(data.started)) data.started = now; // S-1
  if (dest === 'closed' && fromState !== 'closed') data.completed = now; // S-2a
  if (fromState === 'closed' && dest !== 'closed') delete data.completed; // S-2b
  const entry = { type: 'moved', date: now, author, from, to };
  data.history = [...(task.data.history ?? []), entry];
  return { changed: true, data, entry };
}

// ── 작업 공간 로더 ──────────────────────────────────────────
export function loadBoard(file = BOARD_FILE) {
  if (!exists(file)) {
    throw new Rejection({ code: 'BOARD-MISSING', file: BOARD_FILE_LABEL, message: `보드 설정(${BOARD_FILE_LABEL})이 없다: ${file}`, fix: '엔진 설치가 깨졌다. workbench 플러그인을 다시 설치하고, 계속되면 사용자에게 알린다', owner: 'user', exit: EXIT.ENV });
  }
  return parseBoard(read(file), file === BOARD_FILE ? BOARD_FILE_LABEL : rel(file));
}

/**
 * board/tasks/의 이슈 전부. 형식이 깨진 파일도 error를 달고 목록에 넣는다(lint가 보고한다).
 * 이슈마다 column 상태(state)·closed와, parent로 계산한 children을 붙인다.
 */
export function loadBoardTasks(board = loadBoard(), dir = TASKS) {
  const tasks = exists(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => {
      const file = path.join(dir, f);
      const parsed = parseTaskText(read(file));
      const state = stateOf(board, parsed.data.column);
      return { ...parsed, file, rel: rel(file), name: f.slice(0, -3), state, closed: state === 'closed', archived: parsed.data.archived === true, children: [] };
    })
    : [];
  const byId = new Map(tasks.filter((t) => t.data.task_id).map((t) => [t.data.task_id, t]));
  for (const t of tasks) if (t.data.parent) byId.get(t.data.parent)?.children.push(t);
  return tasks;
}

export const recordsDirOfTask = (t, root = RECORDS) => (t.data.project && t.data.task_id ? path.join(root, t.data.project, t.data.task_id) : null);

/** find-task 출력 형태 */
export function summarizeBoardTask(t, board, root = RECORDS) {
  const dir = recordsDirOfTask(t, root);
  const col = board.byId.get(t.data.column);
  return {
    task_id: t.data.task_id ?? null, title: t.data.title ?? null, project: t.data.project ?? null, type: t.data.type ?? null, author: effectiveAuthor(t.data),
    column: t.data.column ?? null, columnLabel: col?.label ?? null, closed: t.closed, archived: t.archived,
    started: t.data.started ?? null, completed: t.data.completed ?? null,
    parent: t.data.parent ?? null, children: t.children.map((c) => c.data.task_id),
    file: t.rel,
    recordsDir: dir ? rel(dir) : null, recordsDirExists: !!dir && exists(dir),
    records: dir && exists(dir) ? listFiles(dir).filter((f) => f.endsWith('.md')).map(rel) : [],
    outputs: [].concat(t.data.outputs ?? []),
  };
}

/**
 * 보관·꺼내기. 보관은 종료(closed) 컬럼의 이슈만 한다. 파일은 그대로 두고 archived 표시만 바꾼다(링크가 깨지지 않게).
 * @returns {{changed: false} | {changed: true, data: object, entry: object}}
 */
export function planArchive(task, board, { now, author, restore = false }) {
  const archived = task.data.archived === true;
  if (restore ? !archived : archived) return { changed: false };
  if (!restore && stateOf(board, task.data.column) !== 'closed') {
    throw new Rejection({
      code: 'TASK-NOT-CLOSED', message: `${task.data.task_id}는 종료되지 않았다('${board.byId.get(task.data.column)?.label ?? task.data.column}'). 보관은 종료 컬럼의 이슈만 한다`,
      fix: ['먼저 종료 컬럼으로 옮길지 사용자에게 확인한다: wb move-task <task_id> <종료 컬럼 id>'], owner: 'user',
    });
  }
  const data = { ...task.data };
  if (restore) delete data.archived;
  else data.archived = true;
  const entry = { type: restore ? 'restored' : 'archived', date: now, author };
  data.history = [...(task.data.history ?? []), entry];
  return { changed: true, data, entry };
}
