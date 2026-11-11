import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, cli, boardTask, withRemote } from './fixture.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'cli');
let fx;
let rm;
beforeEach(() => { fx = makeWorkspace(); rm = withRemote(fx); });
afterEach(() => fx.cleanup());

const sync = (args, opts) => cli(fx, 'sync', args, { json: true, ...opts });
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();
const remoteLog = () => git(rm.remote, 'log', '--format=%s', 'main');
const NEW = 'board/tasks/KEYA-3.md';
const newTask = (title = 'New task') => fx.write(NEW, boardTask({ id: 'KEYA-3', title }));

const assertRejection = (r, code, exit = 1) => {
  assert.equal(r.code, exit, r.err || r.out);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, code, JSON.stringify(r.json));
  assert.ok(r.json.fix.length > 0);
};

/**
 * 우리 push 직전에 다른 PC가 먼저 push하게 만든다 (pre-push hook).
 * push 거부는 fetch와 push 사이에 원격이 바뀌어야 생기므로, 테스트에서는 이렇게 재현한다.
 */
function otherPushesFirst(files) {
  const other = rm.clone('other-pc');
  for (const [p, s] of Object.entries(files)) other.write(p, s);
  const mark = path.join(fx.ws, 'pushed-once').split(path.sep).join('/');
  const dir = other.dir.split(path.sep).join('/');
  const hook = path.join(fx.wb, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, `#!/bin/sh
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX
if [ ! -f "${mark}" ]; then
  touch "${mark}"
  cd "${dir}" && git add -A && git -c user.name=o -c user.email=o@o commit -qm "other pc" && git push -q origin main
fi
exit 0
`);
  fs.chmodSync(hook, 0o755);
}

test('sync: begin → 쓰기 → commit이 대상만 커밋하고 push한다', () => {
  assert.equal(sync(['begin']).json.ok, true);
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'chore: 이슈 등록 (KEYA-3)\n\nCo-Authored-By: x']);
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(r.json.pushed, true);
  assert.equal(r.json.retried, false);
  assert.match(remoteLog(), /^chore: 이슈 등록 \(KEYA-3\)/);
  assert.match(git(rm.remote, 'log', '-1', '--format=%B', 'main'), /Co-Authored-By: x/); // 메시지를 그대로 쓴다
});

test('sync: 작업 트리가 깨끗하고 lint --all이 통과하면 트레일러를 기존 트레일러 블록에 잇는다', () => {
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'chore: 이슈 등록 (KEYA-3)\n\nCo-Authored-By: x']);
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(git(rm.remote, 'log', '-1', '--format=%B', 'main'), 'chore: 이슈 등록 (KEYA-3)\n\nCo-Authored-By: x\nWorkbench-Lint: all-passed');
});

test('sync: 대상 밖 미커밋 변경이 있거나 lint --all이 실패하면 트레일러를 붙이지 않는다', () => {
  fx.write('board/tasks/KEYA-1.md', `${fx.read('board/tasks/KEYA-1.md')}손 편집\n`);
  newTask();
  sync(['commit', '--files', NEW, '--message', 'chore: a (KEYA-3)']);
  assert.doesNotMatch(git(rm.remote, 'log', '-1', '--format=%B', 'main'), /Workbench-Lint/);
  git(fx.wb, 'checkout', '--', 'board/tasks/KEYA-1.md');
  fx.write('records/alpha/KEYA-2/discovery.md', `${fx.read('records/alpha/KEYA-2/discovery.md')}[깨짐](nope.md)\n`); // 대상 밖 기존 오류
  git(fx.wb, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'broken record', '--no-verify');
  newTask('Renamed');
  sync(['commit', '--files', NEW, '--message', 'chore: b (KEYA-3)']);
  assert.doesNotMatch(git(rm.remote, 'log', '-1', '--format=%B', 'main'), /Workbench-Lint/);
});

test('sync: 미리 git rm으로 스테이징한 삭제가 대상에 섞여도 대상 전부를 한 커밋에 넣는다', () => {
  const NOTE = 'records/alpha/note.md';
  fx.write(NOTE, '---\ntitle: n\nlifecycle: record\nrepos: []\nbase: unknown\nupdated: 2026-10-02\n---\n\n# n\n');
  git(fx.wb, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', NOTE);
  git(fx.wb, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'note');
  git(fx.wb, 'push', '-q', 'origin', 'main');
  fx.write('board/tasks/KEYA-1.md', `${fx.read('board/tasks/KEYA-1.md')}본문 추가\n`);
  git(fx.wb, 'rm', '-q', NOTE);
  const r = sync(['commit', '--files', 'board/tasks/KEYA-1.md', NOTE, '--message', 'chore: 수정과 삭제']);
  assert.equal(r.code, 0, r.err || r.out);
  assert.deepEqual(git(rm.remote, 'show', '--name-status', '--format=', 'main').split('\n').sort(), ['D\trecords/alpha/note.md', 'M\tboard/tasks/KEYA-1.md']);
  assert.equal(git(fx.wb, 'status', '--porcelain'), '');
});

test('sync: 작업 트리·인덱스·HEAD 어디에도 없는 대상 경로는 커밋 전에 거부하고, 다른 대상의 스테이징도 건드리지 않는다', () => {
  fx.write('board/tasks/KEYA-1.md', `${fx.read('board/tasks/KEYA-1.md')}본문 추가\n`);
  const before = git(rm.remote, 'rev-parse', 'main');
  const r = sync(['commit', '--files', 'board/tasks/KEYA-1.md', 'records/alpha/nope.md', '--message', 'chore: x']);
  assertRejection(r, 'SYNC-NO-TARGET', 2);
  assert.match(r.json.message, /records\/alpha\/nope\.md/);
  assert.equal(git(rm.remote, 'rev-parse', 'main'), before);
  assert.equal(git(fx.wb, 'status', '--porcelain', '--', 'board/tasks/KEYA-1.md'), 'M board/tasks/KEYA-1.md');
});

test('sync: git add가 실패하면 커밋하지 않고 git 출력을 담아 멈춘다', () => {
  fx.write('board/tasks/KEYA-1.md', `${fx.read('board/tasks/KEYA-1.md')}본문 추가\n`);
  fs.writeFileSync(path.join(fx.wb, '.git', 'index.lock'), ''); // 다른 git 프로세스가 index를 잡고 있다
  const head = git(fx.wb, 'rev-parse', 'HEAD');
  const r = sync(['commit', '--files', 'board/tasks/KEYA-1.md', '--message', 'chore: x']);
  fs.rmSync(path.join(fx.wb, '.git', 'index.lock'));
  assertRejection(r, 'SYNC-ADD-FAILED');
  assert.match(r.json.fix[0], /index\.lock/);
  assert.equal(git(fx.wb, 'rev-parse', 'HEAD'), head);
});

test('sync: 커밋 뒤에도 대상 파일에 변경이 남으면 push하지 않고 멈춘다', () => {
  // pre-commit이 대상 파일을 다시 고치는 상황(스테이징 뒤 다른 프로세스가 같은 파일을 씀)을 흉내 낸다
  const hook = path.join(fx.wb, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\necho "늦은 편집" >> board/tasks/KEYA-1.md\nexit 0\n');
  fs.chmodSync(hook, 0o755);
  git(fx.wb, 'config', 'core.hooksPath', '.git/hooks');
  fx.write('board/tasks/KEYA-1.md', `${fx.read('board/tasks/KEYA-1.md')}본문 추가\n`);
  const before = git(rm.remote, 'rev-parse', 'main');
  const r = sync(['commit', '--files', 'board/tasks/KEYA-1.md', '--message', 'chore: x']);
  assertRejection(r, 'SYNC-INCOMPLETE');
  assert.match(r.json.message, /board\/tasks\/KEYA-1\.md/);
  assert.equal(git(rm.remote, 'rev-parse', 'main'), before);
});

test('sync: begin이 원격의 새 커밋을 fast-forward로 받는다', () => {
  const other = rm.clone('other-pc');
  other.write('board/tasks/KEYA-9.md', boardTask({ id: 'KEYA-9', title: 'Other' }));
  other.git('add', '-A'); other.git('commit', '-qm', 'other'); other.git('push', '-q', 'origin', 'main');
  const r = sync(['begin']);
  assert.equal(r.json.pulled, 1);
  assert.ok(fx.exists('board/tasks/KEYA-9.md'));
});

test('sync: HEAD가 main이 아니면 쓰기 전에 멈춘다 (F-3)', () => {
  rm.git('switch', '-q', '-c', 'feature/x');
  assertRejection(sync(['begin']), 'SYNC-NOT-MAIN');
  newTask();
  assertRejection(sync(['commit', '--files', NEW, '--message', 'm']), 'SYNC-NOT-MAIN');
});

test('sync: 대상 파일에 손 편집이 있으면 begin이 멈춘다 (F-2)', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task (hand edit)' }));
  assertRejection(sync(['begin', '--files', 'board/tasks/KEYA-1.md']), 'SYNC-DIRTY-TARGET');
});

test('sync: 대상 밖 미커밋 변경은 커밋하지 않고, 대상 밖 스테이징은 거부한다 (F-1)', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task (hand edit)' }));
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'chore: x (KEYA-3)']);
  assert.equal(r.code, 0, r.err || r.out);
  assert.deepEqual(git(fx.wb, 'show', '--name-only', '--format=', 'HEAD').split('\n'), [NEW]);
  assert.match(fx.read('board/tasks/KEYA-1.md'), /hand edit/);

  rm.git('add', 'board/tasks/KEYA-1.md');
  fx.write('board/tasks/KEYA-4.md', boardTask({ id: 'KEYA-4', title: 'Four' }));
  assertRejection(sync(['commit', '--files', 'board/tasks/KEYA-4.md', '--message', 'm']), 'SYNC-STAGED-OTHER');
});

test('sync: lint 오류가 있으면 hook 없이도 커밋하지 않는다 (F-6)', () => {
  fx.write(NEW, '---\ntask_id: KEYA-3\n---\n'); // 필수 필드 누락
  assertRejection(sync(['commit', '--files', NEW, '--message', 'm']), 'SYNC-LINT');
  assert.equal(git(fx.wb, 'status', '--porcelain', '--', NEW), `?? ${NEW}`);
});

test('sync: push가 거부되면 원격 위에 다시 올려 push하고, 남의 미커밋 변경은 지킨다 (F-1 + F-4)', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task (hand edit)' }));
  otherPushesFirst({ 'board/tasks/KEYA-9.md': boardTask({ id: 'KEYA-9', title: 'Other' }) });
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'chore: x (KEYA-3)']);
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(r.json.retried, true);
  assert.deepEqual(remoteLog().split('\n').slice(0, 2), ['chore: x (KEYA-3)', 'other pc']);
  assert.match(fx.read('board/tasks/KEYA-1.md'), /hand edit/);
  assert.equal(git(fx.wb, 'stash', 'list'), '');
  // 작업 트리를 rebase하지 않고 로컬 main만 push한 커밋으로 옮기고, 원격이 바꾼 파일만 받는다
  assert.equal(git(fx.wb, 'rev-parse', 'main'), git(rm.remote, 'rev-parse', 'main'));
  assert.match(fx.read('board/tasks/KEYA-9.md'), /Other/);
  assert.equal(git(fx.wb, 'status', '--porcelain'), 'M board/tasks/KEYA-1.md');
});

test('sync: 같은 이슈 파일이 양쪽에 생기면 멈추고, 다음 begin은 갈라짐으로 거부한다 (F-5)', () => {
  otherPushesFirst({ [NEW]: boardTask({ id: 'KEYA-3', title: 'Other PC same id' }) });
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'chore: x (KEYA-3)']);
  assertRejection(r, 'SYNC-CONFLICT');
  assert.equal(r.json.owner, 'user');
  assert.match(git(fx.wb, 'log', '-1', '--format=%s'), /KEYA-3/); // 로컬 커밋은 남는다
  assertRejection(sync(['begin']), 'SYNC-DIVERGED');
});

test('sync: 원격이 바꾼 파일에 남의 미커밋 편집이 있으면 push하지 않고 멈추며, 편집은 그대로 둔다 (O-4)', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Local hand edit' }));
  otherPushesFirst({ 'board/tasks/KEYA-1.md': boardTask({ id: 'KEYA-1', title: 'Remote edit' }) });
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'chore: x (KEYA-3)']);
  assertRejection(r, 'SYNC-FF-BLOCKED');
  assert.equal(remoteLog().split('\n')[0], 'other pc'); // 우리 커밋은 push되지 않았다
  assert.match(fx.read('board/tasks/KEYA-1.md'), /Local hand edit/);
  assert.equal(git(fx.wb, 'stash', 'list'), '');
});

test('sync: 잠금을 다른 살아 있는 프로세스가 잡고 있으면 기다리다 SYNC-BUSY로 거부한다', () => {
  const lock = path.join(fx.wb, '.git', 'workbench-sync.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), label: 'test' }));
  const r = sync(['begin'], { env: { WORKBENCH_SYNC_LOCK_TIMEOUT_MS: '500' } });
  assertRejection(r, 'SYNC-BUSY', 3);
  assert.ok(fs.existsSync(lock)); // 남의 잠금은 지우지 않는다
});

test('sync: 죽은 프로세스의 잠금은 치우고 진행한다', () => {
  const lock = path.join(fx.wb, '.git', 'workbench-sync.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, at: Date.now(), label: 'dead' }));
  const r = sync(['begin'], { env: { WORKBENCH_SYNC_LOCK_TIMEOUT_MS: '2000' } });
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(fs.existsSync(lock), false);
});

test('sync: 같은 PC에서 두 commit을 동시에 돌려도 둘 다 push된다', async () => {
  const a = 'board/tasks/KEYA-3.md';
  const b = 'board/tasks/KEYA-4.md';
  fx.write(a, boardTask({ id: 'KEYA-3', title: 'A' }));
  fx.write(b, boardTask({ id: 'KEYA-4', title: 'B' }));
  const run = (file, msg) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(BIN, 'sync.mjs'), 'commit', '--files', file, '--message', msg, '--json'], { cwd: fx.wb, env: { ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml') } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const [ra, rb] = await Promise.all([run(a, 'chore: a (KEYA-3)'), run(b, 'chore: b (KEYA-4)')]);
  assert.equal(ra.code, 0, ra.out);
  assert.equal(rb.code, 0, rb.out);
  assert.deepEqual(remoteLog().split('\n').slice(0, 2).sort(), ['chore: a (KEYA-3)', 'chore: b (KEYA-4)']);
  assert.equal(git(fx.wb, 'status', '--porcelain'), '');
});

test('sync: WORKBENCH_SYNC=skip이면 원격 없이도 건너뛴다', () => {
  rm.git('remote', 'remove', 'origin');
  newTask();
  const r = sync(['commit', '--files', NEW, '--message', 'm'], { env: { WORKBENCH_SYNC: 'skip' } });
  assert.equal(r.json.skipped, true);
  assertRejection(sync(['begin']), 'SYNC-NO-REMOTE', 3);
});

test('sync: WORKBENCH_SYNC=local이면 원격 없이 대상만 로컬 커밋하고 dirty 검사는 그대로 한다', () => {
  rm.git('remote', 'remove', 'origin');
  const env = { WORKBENCH_SYNC: 'local' };
  newTask();
  assert.equal(sync(['begin'], { env }).json.local, true);
  fx.write('records/alpha/other.md', 'x\n'); // 대상 밖 변경은 커밋하지 않는다
  const r = sync(['commit', '--files', NEW, '--message', 'local commit'], { env });
  assert.equal(r.code, 0, r.err || r.out);
  assert.equal(r.json.pushed, false);
  assert.ok(r.json.committed);
  assert.equal(git(fx.wb, 'log', '-1', '--format=%s'), 'local commit');
  assert.match(git(fx.wb, 'status', '--porcelain'), /records\/alpha\/other\.md/);
  newTask('Edited');
  assertRejection(sync(['begin', '--files', NEW], { env }), 'SYNC-DIRTY-TARGET');
});

test('sync: 사용법 오류는 종료 코드 2', () => {
  assertRejection(sync(['commit', '--files', NEW]), 'USAGE', 2);
  assertRejection(sync(['push']), 'USAGE', 2);
});
