#!/usr/bin/env node
// 종료된 이슈(✅ Done / 🗑️ Dropped)의 기록과 대상 저장소의 문서 루트를 나열한다.
// 흡수 여부(확정 내용이 상시 문서에 반영됐는지)는 판단하지 않는다 — /documentation이 이 목록을 입력으로 판단한다.
import path from 'node:path';
import { run, args, Rejection } from './lib/report.mjs';
import { repoDir, rel, exists, read, parseFrontmatter, loadProjects, resolveRepo, requireTask, listFiles } from './lib/workbench.mjs';
import { loadBoard, loadBoardTasks, recordsDirOfTask } from './lib/board.mjs';
import { loadSharedConfig } from './lib/shared-config.mjs';

const USAGE = `사용법: wb absorb-candidates [--task <task_id> | --project <project>] [--since <YYYY-MM-DD>]
  --since  이 날짜 이후에 종료된 이슈만`;

run(async () => {
  const { values } = args({ task: { type: 'string' }, project: { type: 'string' }, since: { type: 'string' } }, USAGE, { positionals: false });
  const projects = loadProjects();
  // 저장소 안 문서 루트 후보는 공유 설정 docRoots(기본 src/main/resources/docs, docs)
  const DOC_ROOTS = loadSharedConfig().docRoots;
  const board = loadBoard();
  const tasks = loadBoardTasks(board);
  const label = (t) => board.byId.get(t.data.column)?.label ?? t.data.column;
  let closed;
  if (values.task) {
    const t = requireTask(tasks, values.task);
    if (!t.closed) {
      throw new Rejection({
        code: 'TASK-NOT-CLOSED', file: t.rel, message: `${values.task}는 아직 종료되지 않았다 ('${label(t)}')`,
        fix: ['흡수는 이슈가 ✅ Done / 🗑️ Dropped가 된 뒤에 한다. 진행 중 이슈의 기록은 고쳐 쓸 수 있으므로 지금 옮기지 않는다'],
      });
    }
    closed = [t];
  } else {
    closed = tasks.filter((t) => t.closed && (!values.project || t.data.project === values.project));
    if (values.since) closed = closed.filter((t) => (t.data.completed ?? '') >= values.since);
  }

  const out = closed.map((t) => {
    const dir = recordsDirOfTask(t);
    const records = dir && exists(dir) ? listFiles(dir).filter((f) => f.endsWith('.md')).map((f) => {
      const fm = parseFrontmatter(read(f));
      return { file: rel(f), title: fm.data.title ?? null, repos: [].concat(fm.data.repos ?? []) };
    }) : [];
    const repoNames = new Set([...(projects.byProject.get(t.data.project)?.repos ?? []), ...records.flatMap((r) => r.repos.map((n) => resolveRepo(projects, n)).filter(Boolean))]);
    const repos = [...repoNames].map((r) => ({
      repo: r,
      docRoots: DOC_ROOTS.filter((d) => exists(path.join(repoDir(r), d))).map((d) => `${r}/${d}`),
    }));
    return { task_id: t.data.task_id, title: t.data.title, column: label(t), completed: t.data.completed ?? null, project: t.data.project, records, repos };
  }).filter((c) => c.records.length > 0);

  const text = out.length === 0 ? '대상 없음: 기록이 있는 종료 이슈가 없다' : out.map((c) => [
    `${c.task_id} ${c.title} (${c.column}, ${String(c.completed ?? '').slice(0, 10)})`,
    ...c.records.map((r) => `  기록: ${r.file}${r.title ? ` — ${r.title}` : ''}`),
    ...c.repos.map((r) => `  저장소: ${r.repo}${r.docRoots.length ? ` (문서 루트 ${r.docRoots.join(', ')})` : ' (문서 루트 없음)'}`),
  ].join('\n')).join('\n\n') + '\n\n판단: 확정된 규칙·구조·계약·절차가 저장소 문서에 있는지 /documentation으로 확인한다. 이 목록은 후보일 뿐이다';
  return { data: { candidates: out }, text };
}, USAGE);
