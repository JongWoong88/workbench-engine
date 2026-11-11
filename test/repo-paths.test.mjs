// 서비스 저장소가 문서 저장소 옆에 있지 않은 PC: workspace-root를 바꾸거나 repo-path로 저장소마다 옮긴다.
// 기록·산출물의 링크는 논리 경로(문서 저장소의 상위 폴더 기준)로 쓰고, 확인은 이 PC의 실제 폴더에서 한다
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorkspace, cli, boardTask } from './fixture.mjs';

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

const RECORD = '---\ntitle: r\nlifecycle: record\ntask_id: KEYA-1\nrepos: [alpha-repo]\nbase: unknown\nupdated: 2026-11-11\n---\n\n# r\n\n'
  + '- [있음](../../../../org/alpha-repo/docs/guide.md)\n- [없음](../../../../org/alpha-repo/docs/missing.md)\n';
const OUTPUTS = "outputs:\n  - kind: 문서\n    path: ../org/alpha-repo/docs/guide.md\n  - kind: 문서\n    path: ../org/alpha-repo/docs/missing.md\n  - kind: 계획\n    path: records/alpha/KEYA-1/plan.md\n";

function moveRepo(to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(path.join(fx.ws, 'org', 'alpha-repo'), to);
}
function writeLinks() {
  fx.write('records/alpha/KEYA-1/plan.md', RECORD);
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task', extra: OUTPUTS }));
}
const findings = (r, rule) => r.json.findings.filter((f) => f.rule === rule).map((f) => f.message.split(': ').at(-1)).sort();

for (const [name, setup] of [
  ['workspace-root를 다른 폴더로 둔 PC', () => {
    const other = path.join(fx.ws, 'other-ws');
    moveRepo(path.join(other, 'org', 'alpha-repo'));
    return { WORKSPACE_ROOT: other };
  }],
  ['repo-path로 저장소 하나를 옮긴 PC', () => {
    const dir = path.join(fx.ws, 'moved', 'alpha');
    moveRepo(dir);
    assert.equal(cli(fx, 'config', ['set', 'repo-path', 'org/alpha-repo', dir]).code, 0);
    return {};
  }],
]) {
  test(`lint: ${name}에서도 저장소 링크와 산출물을 실제 폴더에서 확인한다`, () => {
    const env = setup();
    writeLinks();
    const r = cli(fx, 'lint', ['--all'], { json: true, env });
    assert.deepEqual(findings(r, 'LINK-EXTERNAL'), ['../../../../org/alpha-repo/docs/missing.md']);
    assert.deepEqual(findings(r, 'TASK-OUTPUT'), ['../org/alpha-repo/docs/missing.md']);
  });
}

test('lint: 저장소가 이 PC에 없으면 저장소 링크와 산출물은 건너뛴다', () => {
  fs.rmSync(path.join(fx.ws, 'org', 'alpha-repo'), { recursive: true, force: true });
  writeLinks();
  const r = cli(fx, 'lint', ['--all'], { json: true });
  assert.deepEqual(findings(r, 'LINK-EXTERNAL'), []);
  assert.deepEqual(findings(r, 'TASK-OUTPUT'), []);
});

test('new-record·link-output·absorb-candidates: repo-path의 실제 폴더를 쓰고 산출물은 논리 경로로 남긴다', () => {
  const dir = path.join(fx.ws, 'moved', 'alpha');
  moveRepo(dir);
  cli(fx, 'config', ['set', 'repo-path', 'org/alpha-repo', dir]);

  // base는 옮긴 저장소의 HEAD에서 읽는다
  const rec = cli(fx, 'new-record', ['--to', 'KEYA-1', '--name', 'plan-y.md', '--title', 'Y'], { json: true });
  assert.equal(rec.code, 0, rec.out + rec.err);
  assert.match(fx.read('records/alpha/KEYA-1/plan-y.md'), /base: main@[0-9a-f]+/);

  // 실제 경로로 줘도 논리 경로로 저장한다
  const out = cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '문서', '--path', path.join(dir, 'docs', 'guide.md'), '--desc', '안내'], { json: true });
  assert.equal(out.code, 0, out.out + out.err);
  assert.equal(out.json.output.path, '../org/alpha-repo/docs/guide.md');
  // 논리 경로로 줘도 찾는다
  const again = cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', '문서', '--path', '../org/alpha-repo/docs/guide.md', '--desc', '안내'], { json: true });
  assert.equal(again.code, 0, again.out + again.err);

  const abs = cli(fx, 'absorb-candidates', [], { json: true });
  assert.deepEqual(abs.json.candidates.find((c) => c.task_id === 'KEYA-2').repos, [{ repo: 'org/alpha-repo', docRoots: ['org/alpha-repo/docs'] }]);
});
