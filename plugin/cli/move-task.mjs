#!/usr/bin/env node
// 이슈를 다른 컬럼으로 옮긴다. 사용자가 컬럼 이동을 지시했을 때만 부른다.
//   started·completed와 history는 design-data-model.md "상태 규칙"대로 기록한다.
//   종료 컬럼으로 옮길 때 끝나지 않은 child(parent가 이 이슈인 이슈)가 있으면 거부한다.
import fs from 'node:fs';
import { run, args, usage, Rejection } from './lib/report.mjs';
import { requireTask, cmdline, git } from './lib/workbench.mjs';
import { loadBoard, loadBoardTasks, planMove, stringifyTask } from './lib/board.mjs';

const USAGE = `사용법: wb move-task <task_id> <컬럼 id> [--force]
  컬럼 id는 board/board.yml의 columns[].id (예: design, done)
  --force  끝나지 않은 child가 있어도 종료 컬럼으로 옮긴다 (사용자가 명시적으로 결정한 경우만)`;

run(async () => {
  const { values, positionals } = args({ force: { type: 'boolean' } }, USAGE);
  if (positionals.length !== 2) throw usage('task_id와 컬럼 id를 지정해야 한다', USAGE);
  const [id, to] = positionals;
  const board = loadBoard();
  const task = requireTask(loadBoardTasks(board), id);
  if (task.error) {
    throw new Rejection({ code: 'TASK-FORMAT', file: task.rel, message: `${id} 파일을 읽을 수 없다: ${task.error}`, fix: ['`wb lint --files ' + task.rel + '`로 형식 오류를 확인하고 고친다'], owner: 'board' });
  }

  let result;
  try {
    result = planMove(task, to, board, { now: new Date().toISOString(), author: git(['config', 'user.name']).stdout.trim(), children: task.children, force: values.force });
  } catch (e) {
    if (e instanceof Rejection && e.code === 'TASK-OPEN-CHILDREN') { e.file = task.rel; e.rerun = cmdline(['--force']); }
    throw e;
  }
  const label = (c) => board.byId.get(c)?.label ?? c;
  if (!result.changed) {
    return { data: { changed: false, task_id: id, column: to }, text: `변경 없음: ${id}는 이미 '${label(to)}'에 있다` };
  }
  fs.writeFileSync(task.file, stringifyTask(result.data, task.body));

  const notes = [];
  if (board.byId.get(to).state === 'closed') {
    notes.push('이슈가 종료되어 기록이 동결되었다. 확정된 내용의 상시 문서 반영 후보: wb absorb-candidates --task ' + id);
  }
  const from = task.data.column;
  const data = { changed: true, task_id: id, from, to, started: result.data.started ?? null, completed: result.data.completed ?? null, notes };
  return { data, text: [`이동: ${id} '${label(from)}' → '${label(to)}'`, ...notes.map((n) => `  다음: ${n}`)].join('\n') };
}, USAGE);
