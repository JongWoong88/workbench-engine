// 보드를 바꾸는 명령 (board/ 형식)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, cli, boardTask } from './fixture.mjs';
import { parseTaskText } from '../plugin/cli/lib/board.mjs';

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

test('new-task: 번호 발급과 board/tasks/{task_id}.md 생성을 한 번에', () => {
  const r = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'research', '--title', '새 조사: Beta', '--description', '본문 한 줄', '--no-fetch'], { json: true });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json.task_id, 'KEYA-8');
  assert.equal(r.json.branch, 'research/KEYA-8');
  assert.equal(r.json.file, 'board/tasks/KEYA-8.md');
  const t = parseTaskText(fx.read('board/tasks/KEYA-8.md'));
  assert.equal(t.error, undefined);
  assert.equal(t.data.title, '새 조사: Beta');
  assert.equal(t.data.type, 'research');
  assert.equal(t.data.column, 'backlog');
  assert.equal(t.data.author, 'Tester');
  assert.equal(t.data.assigned, 'Tester');
  assert.equal(t.data.history[0].author, 'Tester');
  assert.equal(r.json.author, undefined); // 생성 출력은 그대로다. 작성자는 find-task로 본다
  assert.equal(cli(fx, 'find-task', ['KEYA-8'], { json: true }).json.task.author, 'Tester');
  assert.equal(t.data.started, undefined);
  assert.deepEqual(t.data.history.map((h) => [h.type, h.column]), [['created', 'backlog']]);
  assert.equal(t.body, '본문 한 줄\n');
  // 바로 다음 발급은 예약된 번호를 건너뛴다
  assert.equal(cli(fx, 'next-task-id', ['alpha', '--no-fetch']).out.trim(), 'KEYA-9');
  // 진행 컬럼에 만들면 started를 채운다 (S-1)
  const a = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'Gamma', '--column', 'in-progress', '--no-fetch'], { json: true });
  assert.ok(parseTaskText(fx.read(a.json.file)).data.started);
});

test('new-task --assigned: 담당만 바뀌고 작성자와 생성 이력은 git user.name이다', () => {
  const r = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', '담당 지정', '--assigned', '다른사람', '--no-fetch'], { json: true });
  assert.equal(r.code, 0, r.out + r.err);
  const t = parseTaskText(fx.read(r.json.file));
  assert.equal(t.data.assigned, '다른사람');
  assert.equal(t.data.author, 'Tester');
  assert.equal(t.data.history[0].author, 'Tester');
});

test('new-task: git user.name이 비면 번호를 발급하지 않고 환경 오류로 거부', () => {
  spawnSync('git', ['config', '--unset', 'user.name'], { cwd: fx.wb });
  fs.writeFileSync(path.join(fx.ws, 'empty.gitconfig'), '');
  const before = fs.readdirSync(path.join(fx.wb, 'board', 'tasks')).sort();
  const env = { GIT_CONFIG_GLOBAL: path.join(fx.ws, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const r = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', '작성자 없음', '--no-fetch'], { json: true, env });
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(r.json.code, 'ENV-GIT-USER');
  assert.equal(r.json.owner, 'user');
  assert.deepEqual(fs.readdirSync(path.join(fx.wb, 'board', 'tasks')).sort(), before);
});

test('new-task: 잘못된 태그·컬럼 이름·같은 제목은 거부', () => {
  const bad = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feat', '--title', 'X', '--no-fetch'], { json: true });
  assert.equal(bad.code, 2);
  assert.match(bad.json.message, /'feature'/);
  const label = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'X', '--column', '📋 Backlog', '--no-fetch'], { json: true });
  assert.equal(label.code, 2);
  assert.match(label.json.message, /'backlog'/);
  const dup = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'Alpha Task', '--no-fetch'], { json: true });
  assert.equal(dup.json.code, 'TASK-EXISTS');
});

test('new-task --parent: child 이슈를 만들고, 없는 이슈·두 단계는 거부', () => {
  const child = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'Child', '--parent', 'KEYA-1', '--no-fetch'], { json: true });
  assert.equal(child.code, 0, child.err || child.out);
  const data = parseTaskText(fx.read(child.json.file)).data;
  assert.equal(data.parent, 'KEYA-1');
  assert.equal(cli(fx, 'lint', ['--files', child.json.file]).code, 0);

  const missing = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'Orphan', '--parent', 'KEYA-99', '--no-fetch'], { json: true });
  assert.equal(missing.json.code, 'TASK-NOT-FOUND');
  const grandchild = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'Grandchild', '--parent', child.json.task_id, '--no-fetch'], { json: true });
  assert.equal(grandchild.json.code, 'TASK-PARENT');
  assert.equal(grandchild.json.owner, 'user');
});

test('move-task: 이동·날짜·history, 끝나지 않은 child가 있으면 종료 거부', () => {
  fx.write('board/tasks/KEYA-3.md', boardTask({ id: 'KEYA-3', title: 'Child task', extra: 'parent: KEYA-1\n' }));

  const blocked = cli(fx, 'move-task', ['KEYA-1', 'done'], { json: true });
  assert.equal(blocked.json.code, 'TASK-OPEN-CHILDREN');
  assert.match(blocked.json.rerun, /--force$/);

  const started = cli(fx, 'move-task', ['KEYA-3', 'in-progress'], { json: true });
  assert.equal(started.code, 0, started.out + started.err);
  assert.ok(started.json.started);
  assert.equal(cli(fx, 'move-task', ['KEYA-3', 'done']).code, 0);
  const moved = cli(fx, 'move-task', ['KEYA-1', 'done'], { json: true });
  assert.equal(moved.code, 0, moved.out);
  assert.ok(moved.json.completed);
  const t = parseTaskText(fx.read('board/tasks/KEYA-1.md'));
  assert.equal(t.data.column, 'done');
  assert.deepEqual(t.data.history.at(-1), { type: 'moved', date: moved.json.completed, author: 'Tester', from: 'backlog', to: 'done' });
  assert.equal(cli(fx, 'move-task', ['KEYA-1', 'done'], { json: true }).json.changed, false);
  // 다시 열면 completed를 지운다 (S-2b)
  assert.equal(cli(fx, 'move-task', ['KEYA-1', 'backlog'], { json: true }).json.completed, null);
});

test('move-task: 컬럼 이름이나 없는 컬럼은 id를 안내하며 거부', () => {
  const r = cli(fx, 'move-task', ['KEYA-1', '✅ Done'], { json: true });
  assert.equal(r.code, 2);
  assert.equal(r.json.code, 'COLUMN-UNKNOWN');
  assert.match(r.json.fix[0], /'done'/);
});

// 문서 저장소 템플릿의 pre-commit. wb가 PATH에 있으면 lint --staged로 막고, 없으면 경고만 하고 통과시킨다(D-14)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = path.join(ROOT, 'plugin', 'templates', 'githooks');
/** PATH에서 wb가 있는 폴더를 빼고, extra가 있으면 맨 앞에 둔다 */
const pathWith = (extra) => [extra, ...(process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)
  .filter((d) => d && !fs.existsSync(path.join(d, 'wb')) && !fs.existsSync(path.join(d, 'wb.cmd')))].filter(Boolean).join(path.delimiter);
function hookGit(PATH) {
  const env = { ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml') };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k];
  env.PATH = PATH;
  return (...a) => spawnSync('git', ['-c', `core.hooksPath=${HOOKS}`, ...a], { cwd: fx.wb, encoding: 'utf8', env });
}

test('pre-commit hook: 규칙 위반 파일이 스테이징되면 커밋을 거부한다', () => {
  const git = hookGit(pathWith(path.join(ROOT, 'plugin', 'bin')));
  fx.write('records/alpha/KEYA-1/plan.md', '# 프론트매터 없음\n');
  git('add', '-A');
  const r = git('commit', '-qm', 'bad');
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /REC-FM-MISSING/);
  assert.match(r.stderr, /커밋이 거부되었다/);
});

test('pre-commit hook: wb가 없는 터미널에서는 경고만 하고 커밋한다', () => {
  const git = hookGit(pathWith(null));
  fx.write('records/alpha/KEYA-1/plan.md', '# 프론트매터 없음\n');
  git('add', '-A');
  const r = git('commit', '-qm', 'no wb');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /wb를 찾지 못해/);
});

test('archive-task: 종료 이슈 보관·꺼내기, 진행 중 이슈는 거부, 보관 이슈는 이동 거부', () => {
  const open = cli(fx, 'archive-task', ['KEYA-1'], { json: true });
  assert.equal(open.json.code, 'TASK-NOT-CLOSED');
  const a = cli(fx, 'archive-task', ['KEYA-2'], { json: true });
  assert.equal(a.code, 0, a.out + a.err);
  assert.equal(parseTaskText(fx.read('board/tasks/KEYA-2.md')).data.archived, true);
  assert.equal(cli(fx, 'find-task', ['KEYA-2'], { json: true }).json.task.archived, true);
  assert.equal(cli(fx, 'move-task', ['KEYA-2', 'backlog'], { json: true }).json.code, 'TASK-ARCHIVED');
  assert.equal(cli(fx, 'lint', ['--files', 'board/tasks/KEYA-2.md']).code, 0);
  const r = cli(fx, 'archive-task', ['KEYA-2', '--restore'], { json: true });
  assert.equal(r.json.archived, false);
  assert.deepEqual(parseTaskText(fx.read('board/tasks/KEYA-2.md')).data.history.map((h) => h.type), ['archived', 'restored']);
});
