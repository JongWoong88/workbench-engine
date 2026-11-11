// 테스트용 임시 작업 공간. WORKSPACE_ROOT/workbench 구조로 만들고 명령을 그 위에서 돌린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'cli');

const BOARD_YML = `columns:
  - {id: backlog, label: 📋 Backlog, state: waiting}
  - {id: in-progress, label: 🏃 In Progress, state: active}
  - {id: done, label: ✅ Done, state: closed}
  - {id: dropped, label: 🗑️ Dropped, state: closed}
description: |
  📋 Backlog 착수 전 → 🏃 In Progress 작업중 → ✅ Done 완료 / 🗑️ Dropped 폐기
`;

export const boardTask = ({ id, project = 'alpha', type = 'feature', title, column = 'backlog', body = '', extra = '' }) => `---
task_id: ${id}
title: ${title}
project: ${project}
type: ${type}
column: ${column}
author: tester
created: '2026-10-01T00:00:00.000Z'
${extra}history: []
---
${body ? `\n${body}` : ''}`;

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 실패: ${r.stderr}`);
  return r.stdout;
}

export function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
  const wb = path.join(ws, 'workbench');
  const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(wb, p)), { recursive: true }); fs.writeFileSync(path.join(wb, p), s); };

  // 코드 저장소 하나 (base 계산용)
  const repo = path.join(ws, 'org', 'alpha-repo');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), '# guide\n');
  sh('git', ['init', '-q', '-b', 'main'], repo);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], repo);
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'KEYA-7 init'], repo);

  write('projects.tsv', '# project\tkey\trepos\tgitlab\nalpha\tKEYA\torg/alpha-repo\tgrp/alpha-repo\nbeta\tKEYB\torg/alpha-repo,org/beta-repo\tgrp/alpha-repo,-\ncommon\tKEYC\t-\t-\n');
  write('.gitattributes', ['md', 'yml', 'mjs', 'js', 'html', 'css'].map((e) => `*.${e} text eol=lf\n`).join(''));
  write('board/board.yml', BOARD_YML);
  write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task' }));
  write('board/tasks/KEYA-2.md', boardTask({ id: 'KEYA-2', title: 'Done task', column: 'done', extra: "completed: '2026-10-02T00:00:00.000Z'\noutputs:\n  - kind: 조사\n    path: records/alpha/KEYA-2/discovery.md\n" }));
  write('records/alpha/KEYA-2/discovery.md', '---\ntitle: d\nlifecycle: record\ntask_id: KEYA-2\nrepos: [alpha-repo]\nbase: main@abc1234\nupdated: 2026-10-02\n---\n\n# d\n');

  sh('git', ['init', '-q', '-b', 'main'], wb);
  sh('git', ['config', 'user.name', 'Tester'], wb);
  sh('git', ['config', 'user.email', 't@t'], wb);
  sh('git', ['add', '-A'], wb);
  sh('git', ['commit', '-qm', 'base'], wb);
  return { ws, wb, write, read: (p) => fs.readFileSync(path.join(wb, p), 'utf8'), exists: (p) => fs.existsSync(path.join(wb, p)), cleanup: () => fs.rmSync(ws, { recursive: true, force: true }) };
}

/** bin/<cmd>.mjs를 임시 작업 공간 위에서 실행한다 */
export function cli(fx, cmd, args = [], { json = false, env = {}, cwd = fx.wb } = {}) {
  // env 값이 undefined인 키는 지운다 (WORKSPACE_ROOT 없이 실행하는 테스트용)
  // PC별 설정은 작업 공간 안의 폴더를 쓴다(실제 홈을 건드리지 않는다)
  const merged = { ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml'), ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [path.join(BIN, `${cmd}.mjs`), ...args, ...(json ? ['--json'] : [])], {
    cwd, encoding: 'utf8', env: merged,
  });
  return { code: r.status, out: r.stdout, err: r.stderr, json: json ? JSON.parse(r.stdout) : null };
}

/** fixture workbench에 bare 원격(origin)을 붙이고 main을 올린다. clone(name)은 같은 원격을 받은 다른 PC다 */
export function withRemote(fx) {
  const remote = path.join(fx.ws, 'remote.git');
  const g = (cwd, ...a) => sh('git', ['-c', 'user.name=Other', '-c', 'user.email=o@o', ...a], cwd);
  g(fx.ws, 'init', '-q', '--bare', '-b', 'main', remote);
  g(fx.wb, 'remote', 'add', 'origin', remote);
  g(fx.wb, 'push', '-q', '-u', 'origin', 'main');
  const clone = (name) => {
    const dir = path.join(fx.ws, name);
    g(fx.ws, 'clone', '-q', remote, dir);
    return { dir, git: (...a) => g(dir, ...a), write: (p, s) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), s); } };
  };
  return { remote, clone, git: (...a) => g(fx.wb, ...a) };
}
