import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, cli, boardTask } from './fixture.mjs';
import { parseTaskText } from '../plugin/cli/lib/board.mjs';

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

// 거부 응답은 항상 수정 방법과 책임자를 담는다
const assertRejection = (r, code, exit = 1) => {
  assert.equal(r.code, exit, r.err || r.out);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.code, code);
  assert.ok(r.json.fix.length > 0 && r.json.fix.every((f) => f.length > 0), 'fix가 비어 있다');
  assert.ok(r.json.ownerText);
};

test('next-task-id: 보드·records·저장소 커밋 메시지에서 최대 번호 + 1', () => {
  const r = cli(fx, 'next-task-id', ['alpha', '--no-fetch']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), 'KEYA-8'); // 저장소 커밋 메시지의 KEYA-7
  assert.equal(cli(fx, 'next-task-id', ['common', '--no-fetch']).out.trim(), 'KEYC-1');
});

test('next-task-id: workbench 원격에만 있는 번호도 센다 (다른 PC가 예약한 번호)', () => {
  const remote = path.join(fx.ws, 'remote.git');
  const other = path.join(fx.ws, 'other-pc');
  const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(fx.ws, 'init', '-q', '--bare', '-b', 'main', remote);
  git(fx.wb, 'remote', 'add', 'origin', remote);
  git(fx.wb, 'push', '-q', 'origin', 'HEAD:main');
  git(fx.ws, 'clone', '-q', remote, other);
  fs.writeFileSync(path.join(other, 'board', 'tasks', 'KEYA-20.md'), boardTask({ id: 'KEYA-20', title: 'Other PC' }));
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'other pc task');
  git(other, 'push', '-q', 'origin', 'HEAD:main');

  assert.equal(cli(fx, 'next-task-id', ['alpha', '--no-fetch']).out.trim(), 'KEYA-8'); // fetch 전에는 모른다
  assert.equal(cli(fx, 'next-task-id', ['alpha']).out.trim(), 'KEYA-21');
});

test('next-task-id: 없는 project는 비슷한 값을 안내하며 거부', () => {
  const r = cli(fx, 'next-task-id', ['alpah', '--no-fetch'], { json: true });
  assertRejection(r, 'PROJECT-UNKNOWN');
  assert.match(r.json.fix[0], /'alpha'/);
});

test('사용법 오류는 종료 코드 2', () => {
  const r = cli(fx, 'next-task-id', ['--bogus'], { json: true });
  assertRejection(r, 'USAGE', 2);
});

test('find-task: task_id·제목으로 찾고, 여럿이면 ambiguous', () => {
  const a = cli(fx, 'find-task', ['KEYA-2'], { json: true });
  assert.equal(a.json.status, 'found');
  assert.equal(a.json.task.closed, true);
  assert.deepEqual(a.json.task.records, ['records/alpha/KEYA-2/discovery.md']);
  // board/ 형식: 컬럼은 id와 이름을 함께, Kanbn 전용 필드는 없다
  assert.equal(a.json.task.column, 'done');
  assert.equal(a.json.task.columnLabel, '✅ Done');
  assert.equal(a.json.task.type, 'feature');
  assert.equal(a.json.task.file, 'board/tasks/KEYA-2.md');
  assert.equal(a.json.task.archived, false);
  assert.equal('kanbnId' in a.json.task || 'tags' in a.json.task, false);
  assert.equal(cli(fx, 'find-task', ['task'], { json: true }).json.status, 'ambiguous');
  assertRejection(cli(fx, 'find-task', ['KEYA-99'], { json: true }), 'TASK-NOT-FOUND');
});

test('new-record: 이슈 폴더에 프론트매터(base 포함)와 제목을 만든다', () => {
  const r = cli(fx, 'new-record', ['--to', 'KEYA-1', '--name', 'plan-x.md', '--title', '계획: X'], { json: true });
  assert.equal(r.code, 0, r.out);
  const text = fx.read('records/alpha/KEYA-1/plan-x.md');
  assert.match(text, /^---\ntitle: '계획: X'\nlifecycle: record\ntask_id: KEYA-1\nrepos: \[alpha-repo\]\nbase: main@[0-9a-f]+\nupdated: \d{4}-\d\d-\d\d\n---\n\n# 계획: X\n/);
  assert.equal(r.json.linkFromTask, 'records/alpha/KEYA-1/plan-x.md');
  assertRejection(cli(fx, 'new-record', ['--to', 'KEYA-1', '--name', 'plan-x.md', '--title', 'X'], { json: true }), 'RECORD-EXISTS');
});

test('new-record: 종료된 이슈는 동결이라 거부, 저장소가 여럿이면 --repos 요구', () => {
  assertRejection(cli(fx, 'new-record', ['--to', 'KEYA-2', '--name', 'a.md', '--title', 'A'], { json: true }), 'RECORD-FROZEN');
  assertRejection(cli(fx, 'new-record', ['--to', 'beta', '--name', 'a.md', '--title', 'A'], { json: true }), 'USAGE', 2);
  const ok = cli(fx, 'new-record', ['--to', 'beta', '--name', 'a.md', '--title', 'A', '--repos', 'alpha-repo,beta-repo'], { json: true });
  assert.equal(ok.code, 0, ok.out);
  assert.match(fx.read('records/beta/a.md'), /base: \{alpha-repo: main@[0-9a-f]+, beta-repo: unknown\}/);
  assert.ok(ok.json.notes.some((n) => n.includes('이슈 없는 기록')));
});

test('link-output: outputs에 차례로 덧붙이고, 중복은 넣지 않고, 다른 필드는 그대로 둔다', () => {
  cli(fx, 'new-record', ['--to', 'KEYA-1', '--name', 'discovery.md', '--title', '조사 문서']);
  cli(fx, 'new-record', ['--to', 'KEYA-1', '--name', 'proposal.md', '--title', '제안 문서']);
  const before = parseTaskText(fx.read('board/tasks/KEYA-1.md'));

  const a = cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '조사', '--path', 'records/alpha/KEYA-1/discovery.md', '--desc', '현황'], { json: true });
  assert.equal(a.code, 0, a.err);
  assert.equal(a.json.title, '조사 문서');
  // 다른 기준의 경로(절대경로)도 workbench 루트 기준으로 저장한다
  cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '제안', '--path', `${fx.wb}/records/alpha/KEYA-1/proposal.md`, '--desc', '두 안']);
  cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '문서', '--path', '../org/alpha-repo/docs/guide.md', '--desc', '저장소 문서']);
  const after = parseTaskText(fx.read('board/tasks/KEYA-1.md'));
  assert.deepEqual(after.data.outputs, [
    { kind: '조사', path: 'records/alpha/KEYA-1/discovery.md', desc: '현황' },
    { kind: '제안', path: 'records/alpha/KEYA-1/proposal.md', desc: '두 안' },
    { kind: '문서', path: '../org/alpha-repo/docs/guide.md', desc: '저장소 문서' },
  ]);
  assert.deepEqual({ ...after.data, outputs: undefined }, { ...before.data, outputs: undefined });
  assert.equal(after.body, before.body);

  const dup = cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '조사', '--path', 'records/alpha/KEYA-1/discovery.md', '--desc', '다시'], { json: true });
  assert.equal(dup.json.changed, false);
  assertRejection(cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '조사', '--path', 'records/none.md', '--desc', 'x'], { json: true }), 'OUTPUT-NOT-FOUND');
});

test('lint: 바꾼 파일의 위반만 오류로 보이고, 고칠 방법을 준다', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task', type: 'feat' }));
  fx.write('records/alpha/KEYA-1/design-x.md', '# 설계\n\n[깨진 링크](./nope.md)\n');
  const r = cli(fx, 'lint', [], { json: true });
  assert.equal(r.code, 1);
  const rules = r.json.findings.map((f) => f.rule).sort();
  assert.deepEqual(rules, ['LINK-BROKEN', 'REC-FM-MISSING', 'REC-UNLINKED', 'TASK-TYPE']);
  const unlinked = r.json.findings.find((f) => f.rule === 'REC-UNLINKED');
  assert.match(unlinked.fix[0], /^wb link-output --task KEYA-1 --kind 설계 --path records\/alpha\/KEYA-1\/design-x\.md/);
  assert.equal(r.json.findings.find((f) => f.rule === 'TASK-TYPE').owner, 'board');
  assert.match(r.json.findings.find((f) => f.rule === 'TASK-TYPE').fix[0], /'feature'/);
  assert.match(r.json.findings.find((f) => f.rule === 'REC-FM-MISSING').fix[0], /task_id: KEYA-1/);

  // --files로 좁히면 그 파일 것만
  const only = cli(fx, 'lint', ['--files', 'board/tasks/KEYA-1.md'], { json: true });
  assert.deepEqual(only.json.findings.map((f) => f.rule), ['TASK-TYPE']);
});

test('lint: 중복 task_id와 파일 이름 불일치', () => {
  fx.write('board/tasks/KEYA-9.md', boardTask({ id: 'KEYA-1', title: 'Other' }));
  const r = cli(fx, 'lint', ['--all'], { json: true });
  const rules = new Set(r.json.findings.map((f) => f.rule));
  assert.ok(rules.has('TASK-ID-DUP'));
  assert.ok(rules.has('TASK-FILE'));
  assert.equal(r.json.findings.find((f) => f.rule === 'TASK-ID-DUP').owner, 'user');
});

test('lint: 깨끗한 변경은 통과', () => {
  cli(fx, 'new-record', ['--to', 'KEYA-1', '--name', 'discovery.md', '--title', '조사']);
  cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '조사', '--path', 'records/alpha/KEYA-1/discovery.md', '--desc', '현황']);
  const r = cli(fx, 'lint', [], { json: true });
  assert.equal(r.code, 0, JSON.stringify(r.json.findings, null, 2));
  assert.equal(r.json.ok, true);
});

test('absorb-candidates: 기록이 있는 종료 이슈만, 진행 중 이슈는 거부', () => {
  const r = cli(fx, 'absorb-candidates', [], { json: true });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(r.json.candidates.map((c) => [c.task_id, c.column, c.title]), [['KEYA-2', '✅ Done', 'Done task']]);
  assertRejection(cli(fx, 'absorb-candidates', ['--task', 'KEYA-1'], { json: true }), 'TASK-NOT-CLOSED');
});

test('config: workspace-root 우선순위는 환경변수 > PC별 설정 > 문서 저장소의 상위 폴더', () => {
  const noEnv = { env: { WORKSPACE_ROOT: undefined }, json: true };
  const get = (opts = noEnv) => cli(fx, 'config', ['get'], opts).json;
  assert.equal(get().workspaceRoot, fx.ws);             // 기본: 문서 저장소의 상위 폴더
  assert.match(get().workspaceRootSource, /기본값/);

  const elsewhere = path.join(fx.ws, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const set = cli(fx, 'config', ['set', 'workspace-root', elsewhere], noEnv);
  assert.equal(set.code, 0, set.err || set.out);
  assert.equal(set.json.reposFound, 0);
  assert.equal(get().workspaceRoot, elsewhere);          // PC별 설정
  assert.equal(get({ json: true }).workspaceRoot, fx.ws); // 환경변수가 우선

  assert.equal(cli(fx, 'config', ['set', 'workspace-root', path.join(fx.ws, 'nope')], noEnv).json.code, 'CONFIG-PATH');
  assert.equal(cli(fx, 'config', ['unset', 'workspace-root'], noEnv).code, 0);
  assert.equal(get().workspaceRoot, fx.ws);
  // 설정은 문서 저장소가 아니라 PC별 설정 폴더에 쓴다. 값이 없으면 파일을 지운다
  assert.equal(fx.exists('workbench.local.json'), false);
  assert.equal(fs.existsSync(path.join(fx.ws, '.wb-config', 'config.json')), false);
});

test('config: data-root를 설정하면 WORKBENCH_ROOT 없이도 문서 저장소를 찾고, 환경변수가 우선한다', () => {
  const noRoot = (extra = {}) => ({ env: { WORKBENCH_ROOT: undefined, ...extra }, json: true });
  // 둘 다 없으면 문서를 쓰는 명령은 환경 오류(종료 코드 3)로 멈추고 설정 방법을 안내한다
  const none = cli(fx, 'find-task', ['KEYA-1'], noRoot());
  assert.equal(none.code, 3, none.out + none.err);
  assert.equal(none.json.code, 'ENV-DATA-ROOT');
  assert.match(none.json.fix[0], /set data-root/);
  // 설정 명령과 도움말은 문서 저장소 없이 돈다
  assert.equal(cli(fx, 'config', ['get'], noRoot()).json.dataRoot, null);
  assert.equal(cli(fx, 'find-task', ['--help'], { env: { WORKBENCH_ROOT: undefined } }).code, 0);

  // 문서 저장소가 아닌 폴더는 거부
  const plain = path.join(fx.ws, 'plain');
  fs.mkdirSync(plain);
  assert.equal(cli(fx, 'config', ['set', 'data-root', plain], noRoot()).json.code, 'CONFIG-NOT-DATA');

  const set = cli(fx, 'config', ['set', 'data-root', fx.wb], noRoot());
  assert.equal(set.code, 0, set.out + set.err);
  assert.ok(fs.existsSync(path.join(fx.ws, '.wb-config', 'config.json')));
  const found = cli(fx, 'find-task', ['KEYA-1'], noRoot());
  assert.equal(found.code, 0, found.out + found.err);
  assert.equal(found.json.task.task_id, 'KEYA-1');
  const got = cli(fx, 'config', ['get'], noRoot()).json;
  assert.equal(got.dataRoot, fx.wb);
  assert.match(got.dataRootSource, /PC별 설정/);

  // 환경변수가 설정보다 우선한다
  const other = path.join(fx.ws, 'other');
  fs.mkdirSync(path.join(other, 'board'), { recursive: true });
  assert.equal(cli(fx, 'config', ['get'], { env: { WORKBENCH_ROOT: other }, json: true }).json.dataRoot, other);

  // 설정한 폴더가 문서 저장소가 아니게 되면 명령이 멈춘다
  fs.writeFileSync(path.join(fx.ws, '.wb-config', 'config.json'), JSON.stringify({ dataRoot: plain }));
  assert.equal(cli(fx, 'find-task', ['KEYA-1'], noRoot()).json.code, 'ENV-DATA-ROOT');
  // 깨진 설정 파일은 환경 오류
  fs.writeFileSync(path.join(fx.ws, '.wb-config', 'config.json'), '{');
  const broken = cli(fx, 'find-task', ['KEYA-1'], noRoot());
  assert.equal(broken.code, 3);
  assert.equal(broken.json.code, 'ENV-USER-CONFIG');

  assert.equal(cli(fx, 'config', ['unset', 'data-root'], noRoot()).code, 3); // 깨진 설정은 고치기 전까지 쓰지 않는다
  fs.rmSync(path.join(fx.ws, '.wb-config', 'config.json'));
  assert.equal(cli(fx, 'config', ['unset', 'data-root'], noRoot()).json.removed, false);
});

test('config: repo-path는 논리 경로마다 실제 폴더를 기록하고 해제한다', () => {
  const dir = path.join(fx.ws, 'org', 'alpha-repo');
  const set = cli(fx, 'config', ['set', 'repo-path', 'org/alpha-repo', dir], { json: true });
  assert.equal(set.code, 0, set.out + set.err);
  assert.deepEqual(set.json.notes, []);
  assert.deepEqual(cli(fx, 'config', ['get'], { json: true }).json.repoPaths, { 'org/alpha-repo': dir });
  // projects.tsv에 없는 경로, git이 아닌 폴더는 참고로 알린다
  const note = cli(fx, 'config', ['set', 'repo-path', 'org/unknown', fx.ws], { json: true });
  assert.equal(note.json.notes.length, 2);
  assert.equal(cli(fx, 'config', ['set', 'repo-path', '../x', dir], { json: true }).code, 2);
  assert.equal(cli(fx, 'config', ['unset', 'repo-path', 'org/unknown'], { json: true }).json.removed, true);
  assert.deepEqual(Object.keys(cli(fx, 'config', ['get'], { json: true }).json.repoPaths), ['org/alpha-repo']);
});
