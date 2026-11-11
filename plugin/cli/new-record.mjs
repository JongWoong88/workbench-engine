#!/usr/bin/env node
// 기록 문서 파일을 프론트매터와 제목까지 만든다. 본문은 호출한 쪽(스킬)이 쓴다.
//   - 위치: 이슈가 있으면 records/{project}/{task_id}/, 없으면 records/{project}/
//   - repos·base: projects.tsv에서 저장소 경로를 찾아 `git rev-parse`로 채운다
//   - 이슈가 종료(✅ Done / 🗑️ Dropped)되어 동결됐으면 거부한다
import fs from 'node:fs';
import path from 'node:path';
import { run, args, usage, Rejection, EXIT } from './lib/report.mjs';
import {
  repoDir, RECORDS, TASK_ID_RE, rel, posix, exists, git, today, yamlScalar,
  loadProjects, requireProject, resolveRepo, requireTask,
} from './lib/workbench.mjs';
import { loadBoard, loadBoardTasks } from './lib/board.mjs';

const USAGE = `사용법: wb new-record --to <task_id | project> --name <파일명.md> --title <제목> [--repos <저장소,…> | --repos -] [--print]
  --to     이슈의 task_id(이슈 폴더에 둔다) 또는 project 값(이슈 없는 기록)
  --name   파일명. 하위 폴더 허용 (예: plan-refund.md, qa/QA-login.md)
  --title  문서 제목. 프론트매터 title과 본문 H1에 같이 쓴다
  --repos  근거 저장소 이름(web) 또는 경로(ws/web). 쉼표로 여럿.
           project의 저장소가 하나면 생략 가능. 근거 저장소가 없는 문서는 '-'
  --print  파일을 만들지 않고 프론트매터만 출력한다 (프론트매터가 없는 기존 기록에 붙일 때)`;

run(async () => {
  const { values } = args({
    to: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' },
    repos: { type: 'string' }, print: { type: 'boolean' },
  }, USAGE, { positionals: false });
  for (const k of ['to', 'name', 'title']) if (!values[k]) throw usage(`--${k}가 필요하다`, USAGE);
  if (/[\r\n]/.test(values.title)) throw usage('--title에 줄바꿈을 넣을 수 없다', USAGE);

  const projects = loadProjects();
  let project, taskId = null, dir;
  if (TASK_ID_RE.test(values.to)) {
    const board = loadBoard();
    const task = requireTask(loadBoardTasks(board), values.to);
    if (task.closed) {
      throw new Rejection({
        code: 'RECORD-FROZEN', file: task.rel,
        message: `이슈 ${values.to}는 '${board.byId.get(task.data.column)?.label ?? task.data.column}' 상태라 기록이 동결되었다`,
        fix: [
          '동결된 이슈 폴더에는 새 기록을 만들지 않는다',
          '이 이슈를 다시 열지(컬럼 이동), 새 이슈를 만들지 사용자에게 확인한다. 새 이슈의 기록에서 이전 기록을 링크한다',
        ],
        owner: 'user',
      });
    }
    project = task.data.project;
    requireProject(projects, project, { owner: 'board', file: task.rel });
    taskId = values.to;
    dir = path.join(RECORDS, project, taskId);
  } else {
    project = values.to;
    requireProject(projects, project);
    dir = path.join(RECORDS, project);
  }

  // 파일명: 이슈(또는 project) 폴더 밖으로 나가지 않는 .md
  const name = posix(path.normalize(values.name.replace(/\\/g, '/')));
  if (name.startsWith('..') || path.isAbsolute(name) || !name.endsWith('.md')) {
    throw usage(`--name '${values.name}'는 폴더 안의 상대경로 .md 파일이어야 한다 (예: plan-refund.md, qa/QA-login.md)`, USAGE);
  }
  if (!taskId && /^[A-Z][A-Z0-9]*-\d+\//.test(name)) {
    throw usage(`이슈 폴더(${name.split('/')[0]})에 두려면 --to에 task_id를 쓴다`, USAGE);
  }
  const file = path.join(dir, name);
  if (exists(file) && !values.print) {
    throw new Rejection({
      code: 'RECORD-EXISTS', file: rel(file), message: '같은 이름의 기록이 이미 있다',
      fix: [
        '같은 문서를 고치는 것이면 이 명령 대신 파일을 직접 편집한다 (프론트매터는 유지하고 updated만 오늘 날짜로 바꾼다)',
        '다른 문서라면 주제를 붙인 다른 이름으로 다시 실행한다 (예: design-access-grant.md)',
      ],
    });
  }

  // repos·base
  const row = projects.byProject.get(project);
  let repoPaths;
  if (values.repos === '-') repoPaths = [];
  else if (values.repos) {
    repoPaths = values.repos.split(',').map((s) => s.trim()).filter(Boolean).map((n) => {
      const r = resolveRepo(projects, n);
      if (!r) {
        throw new Rejection({
          code: 'REPO-UNKNOWN', message: `저장소 '${n}'가 projects.tsv에 없다`,
          fix: [`projects.tsv의 저장소 중에서 고른다: ${projects.allRepos.map((r) => r.split('/').pop()).join(', ')}`, '정말 새 저장소라면 사용자에게 확인한 뒤 projects.tsv에 추가한다'],
          exit: EXIT.USAGE,
        });
      }
      return r;
    });
  } else if (row.repos.length === 1) repoPaths = row.repos;
  else {
    throw usage(
      row.repos.length === 0
        ? `project '${project}'에는 저장소가 없다. 근거 저장소를 --repos로 지정하거나, 없으면 --repos -로 실행한다`
        : `project '${project}'의 저장소가 여럿이다(${row.repos.join(', ')}). 이 문서의 근거 저장소를 --repos로 지정한다`,
      USAGE,
    );
  }

  const notes = [];
  const bases = repoPaths.map((r) => {
    const d = repoDir(r);
    const short = r.split('/').pop();
    if (!exists(d)) { notes.push(`${r} 저장소가 이 PC에 없어 base를 unknown으로 적었다`); return [short, 'unknown']; }
    const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], d).stdout.trim();
    const c = git(['rev-parse', '--short', 'HEAD'], d).stdout.trim();
    if (!b || !c) { notes.push(`${r}의 HEAD를 읽지 못해 base를 unknown으로 적었다`); return [short, 'unknown']; }
    return [short, `${b}@${c}`];
  });
  const base = bases.length === 0 ? 'none' : bases.length === 1 ? bases[0][1] : `{${bases.map(([n, v]) => `${n}: ${v}`).join(', ')}}`;

  const fm = [
    '---',
    `title: ${yamlScalar(values.title)}`,
    'lifecycle: record',
    ...(taskId ? [`task_id: ${taskId}`] : []),
    `repos: [${bases.map(([n]) => n).join(', ')}]`,
    `base: ${base}`,
    `updated: ${today()}`,
    '---',
  ].join('\n');

  if (values.print) return { data: { frontmatter: fm, file: rel(file) }, text: fm };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${fm}\n\n# ${values.title}\n\n`);
  if (!taskId) notes.push('이슈 없는 기록이다. 이슈 없이 두었다고 사용자에게 알린다');

  const next = taskId
    ? [`본문을 쓴 뒤 산출물 링크를 단다: wb link-output --task ${taskId} --kind <구분> --path ${rel(file)} --desc "<한 줄 설명>"`]
    : [];
  next.push(`마지막에 검사한다: wb lint --files ${rel(file)}`);
  const data = { file: rel(file), absolute: file, project, task_id: taskId, repos: bases.map(([n]) => n), base, linkFromTask: taskId ? rel(file) : null, notes, next };
  return {
    data,
    text: [`생성: ${rel(file)}`, `  base: ${base}`, ...notes.map((n) => `  참고: ${n}`), ...next.map((n) => `  다음: ${n}`)].join('\n'),
  };
}, USAGE);

