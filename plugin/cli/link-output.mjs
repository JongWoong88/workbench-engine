#!/usr/bin/env node
// 이슈 프론트매터의 outputs(산출물 목록)에 한 항목을 추가한다. 에이전트가 지시 없이 할 수 있는 유일한 보드 수정이다.
//   - 경로는 workbench 루트 기준으로 저장하고, 실제 파일인지 확인한다 (design-data-model.md S-4)
//   - 같은 경로가 이미 있으면 바꾸지 않는다
//   - 이 항목 외에는 아무것도 건드리지 않는다
import fs from 'node:fs';
import path from 'node:path';
import { run, args, usage, Rejection } from './lib/report.mjs';
import { WB, RECORDS, rel, posix, exists, parseFrontmatter, h1, read, requireTask, loadProjects, locateRepoPath, toLogicalPath } from './lib/workbench.mjs';
import { loadBoard, loadBoardTasks, recordsDirOfTask, stringifyTask } from './lib/board.mjs';

const USAGE = `사용법: wb link-output --task <task_id> --kind <구분> --path <문서 경로> --desc <한 줄 설명>
  --kind   워크플로 단계: 조사, 제안, 정책, 결정, 설계, 작업계획, 검토, 검증, QA 등
  --path   workbench 기준(records/...), 절대경로, 또는 현재 폴더 기준 경로
  --title  받기는 하지만 쓰지 않는다. 화면의 제목은 문서 프론트매터 title에서 읽는다`;
const KINDS = ['조사', '제안', '정책', '결정', '설계', '작업계획', '검토', '검증', 'QA'];

run(async () => {
  const { values } = args({ task: { type: 'string' }, kind: { type: 'string' }, path: { type: 'string' }, desc: { type: 'string' }, title: { type: 'string' } }, USAGE, { positionals: false });
  for (const k of ['task', 'kind', 'path', 'desc']) if (!values[k]) throw usage(`--${k}가 필요하다`, USAGE);
  for (const k of ['kind', 'desc']) if (/[\r\n]/.test(values[k])) throw usage(`--${k}에 줄바꿈을 넣을 수 없다`, USAGE);

  const board = loadBoard();
  const task = requireTask(loadBoardTasks(board), values.task);
  if (task.error) {
    throw new Rejection({ code: 'TASK-FORMAT', file: task.rel, message: `${values.task} 파일을 읽을 수 없다: ${task.error}`, fix: ['`wb lint --files ' + task.rel + '`로 형식 오류를 확인한다. 직접 고치지 말고 사용자에게 보고한다'], owner: 'board' });
  }

  // 대상 문서
  const p = values.path.replace(/\\/g, '/');
  // 저장소 문서는 논리 경로(../{워크스페이스}/{저장소}/…)로도, 이 PC의 실제 경로로도 받는다
  const repos = loadProjects().allRepos;
  const target = [path.resolve(WB, p), locateRepoPath(path.resolve(WB, p), repos)?.abs, path.resolve(p)].find((c) => c && exists(c) && fs.statSync(c).isFile());
  if (!target) {
    throw new Rejection({
      code: 'OUTPUT-NOT-FOUND', message: `문서 '${values.path}'를 찾을 수 없다`,
      fix: ['문서를 먼저 만든다 (`wb new-record ...`)', '경로는 workbench 기준(records/{project}/{task_id}/파일.md)으로 준다'],
    });
  }
  const stored = posix(path.relative(WB, toLogicalPath(target, repos)));

  const notes = [];
  if (!KINDS.includes(values.kind)) notes.push(`구분 '${values.kind}'는 흔히 쓰는 값(${KINDS.join('·')})이 아니다. 맞는지 확인한다`);
  if (values.title) notes.push('--title은 쓰지 않는다. 화면의 제목은 문서 프론트매터 title에서 읽는다');
  if (task.closed) notes.push(`이슈가 '${board.byId.get(task.data.column)?.label}' 상태다. 종료된 이슈에 산출물을 단 이유를 사용자에게 알린다`);
  const dir = recordsDirOfTask(task);
  if (target.startsWith(RECORDS + path.sep) && dir && !target.startsWith(dir + path.sep)) {
    notes.push(`이 문서는 이슈 폴더(${rel(dir)}) 밖의 기록이다. 다른 이슈의 기록을 잘못 링크한 것은 아닌지 확인한다`);
  }

  const outputs = [].concat(task.data.outputs ?? []);
  const existing = outputs.findIndex((o) => o?.path === stored);
  if (existing !== -1) {
    return { data: { changed: false, file: task.rel, existing: outputs[existing], notes }, text: [`변경 없음: 이미 산출물에 있다 (${task.rel}, ${outputs[existing].kind})`, ...notes.map((n) => `  참고: ${n}`)].join('\n') };
  }
  const output = { kind: values.kind, path: stored, desc: values.desc };
  fs.writeFileSync(task.file, stringifyTask({ ...task.data, outputs: [...outputs, output] }, task.body));

  const fm = parseFrontmatter(read(target));
  const title = fm.data.title || h1(fm.body) || path.basename(target);
  const shown = `- ${values.kind}: ${title} (${stored}) — ${values.desc}`;
  return {
    data: { changed: true, file: task.rel, output, title, notes },
    text: [`추가: ${task.rel} outputs`, `  ${shown}`, ...notes.map((n) => `  참고: ${n}`), '  보고: 어느 이슈에 어떤 링크를 넣었는지 사용자에게 알린다'].join('\n'),
  };
}, USAGE);
