// task_id 발급. 번호는 원격 저장소 이력과 작업 공간에서 계산한다 (형식 문서(references/workbench-format.md) "task_id")
import fs from 'node:fs';
import path from 'node:path';
import { WB, RECORDS, git, exists, read, loadProjects, requireProject, repoDir } from './workbench.mjs';
import { TASKS } from './board.mjs';
import { withLock } from './lock.mjs';

/**
 * @param {string} project
 * @param {{fetch?: boolean}} [opts]
 * @return {{id: string, key: string, max: number, warnings: string[]}}
 */
export function nextTaskId(project, { fetch = true } = {}) {
  const projects = loadProjects();
  const { key } = requireProject(projects, project);
  const warnings = [];
  const keyRepos = [...new Set(projects.rows.filter((r) => r.key === key).flatMap((r) => r.repos))];

  // 1. 같은 키를 쓰는 모든 project의 저장소를 fetch한다 (원격이 없으면 건너뜀)
  //    workbench 자체도 fetch한다. 다른 PC가 원격에 예약한 번호를 세기 위해서다
  if (fetch) {
    for (const [r, d] of [...keyRepos.map((r) => [r, repoDir(r)]), ['workbench', WB]]) {
      if (!exists(path.join(d, '.git'))) { warnings.push(`경고: 저장소가 없음 — ${r}`); continue; }
      if (!git(['remote'], d).stdout.trim()) continue;
      const doFetch = () => git(['fetch', '--quiet', '--prune'], d, { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      // workbench는 같은 PC의 sync와 git을 함께 쓰므로 sync 잠금 안에서 받는다
      const f = d === WB ? withLock(doFetch, { label: 'next-task-id fetch' }) : doFetch();
      if (!f.ok) warnings.push(`경고: fetch 실패 — ${r} (마지막으로 받아둔 원격 정보로 계산)`);
    }
  }

  // 2. 번호 후보를 모은다
  const sources = [];
  //  - projects.tsv의 모든 저장소: 로컬·원격 브랜치명, 전체 커밋 메시지
  //    (키가 다른 저장소로 옮겨 다닌 이력, push 전 로컬 브랜치까지 잡기 위함)
  for (const r of projects.allRepos) {
    const d = repoDir(r);
    if (!exists(path.join(d, '.git'))) continue;
    sources.push(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'], d).stdout);
    sources.push(git(['log', '--all', '--format=%s'], d).stdout);
  }
  //  - 보드의 task_id — 브랜치 없이 예약된 번호. 파일명과 프론트매터 둘 다 센다
  if (exists(TASKS)) {
    for (const f of fs.readdirSync(TASKS).filter((f) => f.endsWith('.md'))) {
      sources.push(f, (read(path.join(TASKS, f)).match(/^task_id:.*$/gm) || []).join('\n'));
    }
  }
  //  - workbench 저장소: 브랜치명, 전체 커밋 메시지, 원격 브랜치마다의 보드 task_id
  //    (옛 Kanbn 형식 보드의 .kanbn/도 함께 본다)
  if (exists(path.join(WB, '.git'))) {
    sources.push(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']).stdout);
    sources.push(git(['log', '--all', '--format=%s']).stdout);
    for (const ref of git(['for-each-ref', '--format=%(refname)', 'refs/remotes']).stdout.split('\n').filter((r) => r && !r.endsWith('/HEAD'))) {
      sources.push(git(['ls-tree', '--name-only', ref, 'board/tasks/']).stdout);
      sources.push(git(['grep', '-h', '-E', '^task_id:', ref, '--', 'board/tasks', '.kanbn']).stdout);
    }
  }
  //  - records/<project>/<task_id>/ 폴더명
  if (exists(RECORDS)) {
    for (const p of fs.readdirSync(RECORDS, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const e of fs.readdirSync(path.join(RECORDS, p.name), { withFileTypes: true })) {
        if (e.isDirectory()) sources.push(e.name);
      }
    }
  }

  const re = new RegExp(`\\b${key}-(\\d+)\\b`, 'g');
  let max = 0;
  for (const s of sources) for (const m of s.matchAll(re)) max = Math.max(max, Number(m[1]));
  return { id: `${key}-${max + 1}`, key, max, warnings };
}


