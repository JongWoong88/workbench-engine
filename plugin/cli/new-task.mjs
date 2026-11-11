#!/usr/bin/env node
// 보드에 이슈를 만든다. 사용자가 이슈 생성을 지시했을 때만 부른다.
//   task_id 발급과 파일 생성(board/tasks/{task_id}.md)을 한 실행 안에서 해서 번호를 바로 예약한다.
//   생성 컬럼의 상태에 따라 started·completed를 채운다 (design-data-model.md "상태 규칙").
import fs from 'node:fs';
import path from 'node:path';
import { run, args, usage, Rejection, EXIT } from './lib/report.mjs';
import { TAGS, rel, exists, git, suggest, loadProjects, requireProject, requireTask, read } from './lib/workbench.mjs';
import { TASKS, loadBoard, loadBoardTasks, newTaskData, stringifyTask } from './lib/board.mjs';
import { nextTaskId } from './lib/taskid.mjs';

const USAGE = `사용법: wb new-task --project <project> --tag <유형> --title <제목> [--column <컬럼 id>] [--description <본문> | --description-file <파일>] [--assigned <이름>] [--parent <task_id>] [--no-fetch]
  --tag       ${TAGS.join(' | ')}  (브랜치 {유형}/{task_id}의 유형. 이슈의 type 필드가 된다)
  --column    board/board.yml의 컬럼 id. 기본값 backlog
  --assigned  담당자. 기본값은 작성자(workbench 저장소의 git user.name). 작성자는 인자로 바꿀 수 없다
  --parent    상위 이슈의 task_id. 한 단계만 허용한다 (상위 이슈에 parent가 있으면 거부)`;

run(async () => {
  const { values } = args({
    project: { type: 'string' }, tag: { type: 'string' }, title: { type: 'string' }, column: { type: 'string' },
    description: { type: 'string' }, 'description-file': { type: 'string' }, assigned: { type: 'string' }, parent: { type: 'string' }, 'no-fetch': { type: 'boolean' },
  }, USAGE, { positionals: false });
  for (const k of ['project', 'tag', 'title']) if (!values[k]) throw usage(`--${k}가 필요하다`, USAGE);
  if (values.description && values['description-file']) throw usage('--description과 --description-file은 함께 쓸 수 없다', USAGE);

  // 모든 입력을 검사한 뒤에 번호를 발급한다 (거부될 입력으로 fetch하지 않도록)
  requireProject(loadProjects(), values.project);
  if (!TAGS.includes(values.tag)) {
    const near = suggest(values.tag, TAGS);
    throw usage(`tag '${values.tag}'는 허용값이 아니다.${near ? ` '${near}'를 뜻했다면 그것을 쓴다.` : ''} 허용값: ${TAGS.join(', ')}`, USAGE);
  }
  const board = loadBoard();
  const column = values.column ?? 'backlog';
  if (!board.byId.has(column)) {
    const byLabel = board.byLabel.get(column);
    throw usage(`컬럼 '${column}'이 보드에 없다.${byLabel ? ` 컬럼은 이름이 아니라 id로 쓴다: '${byLabel.id}'.` : ''} 있는 컬럼 id: ${board.columns.map((c) => c.id).join(', ')}`, USAGE);
  }
  const title = values.title.trim();
  if (!title || /[\r\n]/.test(title)) throw usage('--title은 한 줄 이상의 글자여야 한다', USAGE);
  // 작성자는 실행한 workbench 저장소의 git user.name이다. 비어 있으면 번호를 발급하기 전에 멈춘다
  const author = git(['config', 'user.name']).stdout.trim();
  if (!author) {
    throw new Rejection({
      code: 'ENV-GIT-USER', message: 'git user.name이 비어 있어 이슈 작성자(author)를 정할 수 없다',
      fix: ['workbench 저장소나 전역 git 설정에 이름을 넣는다: git config user.name <이름>'], owner: 'user', exit: EXIT.ENV,
    });
  }
  const assigned = values.assigned ?? author;
  const tasks = loadBoardTasks(board);
  if (values.parent) {
    const parent = requireTask(tasks, values.parent);
    if (parent.data.parent) {
      throw new Rejection({
        code: 'TASK-PARENT', file: parent.rel, message: `상위 이슈 ${values.parent}도 parent(${parent.data.parent})가 있다. parent는 한 단계만 허용한다`,
        fix: [`가장 위 이슈(${parent.data.parent})를 parent로 줄지 사용자에게 확인한다`], owner: 'user',
      });
    }
  }
  const same = tasks.find((t) => String(t.data.title ?? '').toLowerCase() === title.toLowerCase());
  if (same) {
    throw new Rejection({
      code: 'TASK-EXISTS', file: same.rel, message: `같은 제목의 이슈가 이미 있다: ${same.data.task_id}`,
      fix: [`같은 이슈라면 새로 만들지 말고 기존 이슈를 쓴다 (\`wb find-task ${same.data.task_id}\`)`, '다른 이슈라면 제목을 구별되게 바꿔 다시 실행한다'],
    });
  }
  const description = values['description-file'] ? read(path.resolve(values['description-file'])) : values.description ?? '';

  const issued = nextTaskId(values.project, { fetch: !values['no-fetch'] });
  issued.warnings.forEach((w) => console.error(w));
  const file = path.join(TASKS, `${issued.id}.md`);
  if (exists(file)) {
    throw new Rejection({ code: 'TASK-ID-DUP', file: rel(file), message: `발급한 번호 ${issued.id}의 파일이 이미 있다`, fix: ['번호 계산이 보드를 놓쳤다. 우회하지 말고 이 출력을 사용자에게 보고한다'], owner: 'user' });
  }
  const data = newTaskData({ task_id: issued.id, title, project: values.project, type: values.tag, column, author, assigned, parent: values.parent, now: new Date().toISOString() }, board);
  fs.mkdirSync(TASKS, { recursive: true });
  fs.writeFileSync(file, stringifyTask(data, description.trim() ? `${description.trim()}\n` : ''));

  const notes = issued.warnings.some((w) => w.includes('fetch 실패')) ? ['fetch 실패가 있었다. 번호가 겹칠 수 있으니 사용자에게 알린다'] : [];
  const label = board.byId.get(column).label;
  const out = { task_id: issued.id, file: rel(file), column, columnLabel: label, branch: `${values.tag}/${issued.id}`, notes };
  return {
    data: out,
    text: [`생성: ${issued.id} ${out.file} (${label})`, `  브랜치: ${out.branch}`, ...notes.map((n) => `  참고: ${n}`)].join('\n'),
  };
}, USAGE);
