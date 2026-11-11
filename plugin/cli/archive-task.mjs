#!/usr/bin/env node
// 종료된 이슈를 보관하거나(기본) 꺼낸다(--restore). 사용자가 지시했을 때만 부른다.
//   보관은 종료 컬럼의 이슈만 한다. 파일은 board/tasks/에 그대로 두고 archived 표시와 history만 바꾼다.
//   보관된 이슈는 사이트 기본 화면에서 빠지고 "보관 이슈 보기"로만 보인다. 컬럼 이동은 꺼낸 뒤에 한다.
import fs from 'node:fs';
import { run, args, usage, Rejection } from './lib/report.mjs';
import { requireTask, git } from './lib/workbench.mjs';
import { loadBoard, loadBoardTasks, planArchive, stringifyTask } from './lib/board.mjs';

const USAGE = `사용법: wb archive-task <task_id> [--restore]
  --restore  보관된 이슈를 꺼낸다`;

run(async () => {
  const { values, positionals } = args({ restore: { type: 'boolean' } }, USAGE);
  if (positionals.length !== 1) throw usage('task_id 하나를 지정해야 한다', USAGE);
  const [id] = positionals;
  const board = loadBoard();
  const task = requireTask(loadBoardTasks(board), id);
  if (task.error) {
    throw new Rejection({ code: 'TASK-FORMAT', file: task.rel, message: `${id} 파일을 읽을 수 없다: ${task.error}`, fix: ['`wb lint --files ' + task.rel + '`로 형식 오류를 확인하고 고친다'], owner: 'board' });
  }
  const result = planArchive(task, board, { now: new Date().toISOString(), author: git(['config', 'user.name']).stdout.trim(), restore: values.restore });
  const what = values.restore ? '꺼내기' : '보관';
  if (!result.changed) {
    return { data: { changed: false, task_id: id, archived: task.archived }, text: `변경 없음: ${id}는 이미 ${task.archived ? '보관되어' : '보관되지 않아'} 있다` };
  }
  fs.writeFileSync(task.file, stringifyTask(result.data, task.body));
  return { data: { changed: true, task_id: id, archived: !values.restore }, text: `${what}: ${id}` };
}, USAGE);
