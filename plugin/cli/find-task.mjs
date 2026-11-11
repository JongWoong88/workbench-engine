#!/usr/bin/env node
// 이슈를 task_id·제목으로 찾아 JSON으로 돌려준다. 기록을 쓰는 스킬의 첫 단계에서 부른다.
//   status: found(1건) | ambiguous(여러 건 — 사용자에게 고르게 한다)
//   찾지 못하면 거부(종료 코드 1)
import { run, args, usage, Rejection } from './lib/report.mjs';
import { TASK_ID_RE } from './lib/workbench.mjs';
import { loadBoard, loadBoardTasks, summarizeBoardTask } from './lib/board.mjs';

const USAGE = `사용법: wb find-task <task_id | 제목 일부> [--project <project>]
  task_id는 정확히 일치, 그 밖에는 제목에 포함되는 이슈를 찾는다 (대소문자 무시)
  --project  project 값으로 후보를 좁힌다`;

run(async () => {
  const { values, positionals } = args({ project: { type: 'string' } }, USAGE);
  const q = positionals.join(' ').trim();
  if (!q) throw usage('찾을 task_id나 제목을 지정해야 한다', USAGE);
  const board = loadBoard();
  let tasks = loadBoardTasks(board);
  if (values.project) tasks = tasks.filter((t) => t.data.project === values.project);

  const lower = q.toLowerCase();
  const hits = TASK_ID_RE.test(q)
    ? tasks.filter((t) => t.data.task_id === q)
    : tasks.filter((t) => String(t.data.title ?? '').toLowerCase().includes(lower));

  if (hits.length === 0) {
    throw new Rejection({
      code: 'TASK-NOT-FOUND', message: `'${q}'${values.project ? ` (project ${values.project})` : ''}에 맞는 이슈가 보드에 없다`,
      fix: [
        '검색어를 바꿔 다시 찾는다 (제목의 다른 단어, task_id)',
        '그래도 없으면 이슈를 새로 만들지 말고, 이슈 없이 진행한다고 사용자에게 알린다. 이슈 없는 기록은 `wb new-record --to <project> ...`로 records/{project}/에 둔다',
      ],
    });
  }
  const list = hits.map((t) => summarizeBoardTask(t, board));
  if (list.length === 1) {
    const t = list[0];
    return { data: { status: 'found', task: t }, text: JSON.stringify({ status: 'found', task: t }, null, 2) };
  }
  const data = { status: 'ambiguous', note: '후보가 여럿이다. 임의로 고르지 말고 사용자에게 어느 이슈인지 묻는다', matches: list };
  return { data, text: JSON.stringify(data, null, 2) };
}, USAGE);
