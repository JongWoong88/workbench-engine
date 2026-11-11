// lint의 board/ 규칙: 위반 1건·정상 1건씩
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { makeWorkspace, cli, boardTask } from './fixture.mjs';

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

const lintAll = () => cli(fx, 'lint', ['--all'], { json: true }).json;
const ofRule = (r, rule) => r.findings.filter((f) => f.rule === rule);

test('기본 fixture는 오류가 없다', () => {
  const r = lintAll();
  assert.equal(r.errors, 0, JSON.stringify(r.findings, null, 2));
});

test('TASK-COLUMN: 없는 컬럼, 컬럼 이름을 쓰면 id를 안내한다', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'A', column: '📋 Backlog' }));
  const [f] = ofRule(lintAll(), 'TASK-COLUMN');
  assert.equal(f.file, 'board/tasks/KEYA-1.md');
  assert.match(f.fix[0], /column: backlog/);
});

test('TASK-PARENT: 없는 이슈, 자기 자신, 두 단계', () => {
  fx.write('board/tasks/KEYA-3.md', boardTask({ id: 'KEYA-3', title: 'C', extra: 'parent: KEYA-99\n' }));
  fx.write('board/tasks/KEYA-4.md', boardTask({ id: 'KEYA-4', title: 'D', extra: 'parent: KEYA-4\n' }));
  fx.write('board/tasks/KEYA-5.md', boardTask({ id: 'KEYA-5', title: 'E', extra: 'parent: KEYA-6\n' }));
  fx.write('board/tasks/KEYA-6.md', boardTask({ id: 'KEYA-6', title: 'F', extra: 'parent: KEYA-1\n' }));
  const msgs = ofRule(lintAll(), 'TASK-PARENT').map((f) => `${f.file} ${f.message}`).sort();
  assert.equal(msgs.length, 3);
  assert.match(msgs[0], /KEYA-3\.md parent KEYA-99 이슈가 보드에 없다/);
  assert.match(msgs[1], /KEYA-4\.md parent가 자기 자신/);
  assert.match(msgs[2], /KEYA-5\.md 상위 이슈 KEYA-6도 parent/);
});

test('TASK-OUTPUT: 없는 파일, 같은 경로 두 번. 이 PC에 없는 저장소는 건너뛴다', () => {
  const outputs = [
    'outputs:',
    '  - kind: 조사', '    path: records/alpha/KEYA-2/discovery.md',
    '  - kind: 조사', '    path: records/alpha/KEYA-2/discovery.md',
    '  - kind: 설계', '    path: records/alpha/KEYA-2/nope.md',
    '  - kind: 문서', '    path: ../org/alpha-repo/docs/guide.md',
    '  - kind: 문서', '    path: ../org/missing-repo/docs/x.md',
  ].join('\n') + '\n';
  fx.write('board/tasks/KEYA-2.md', boardTask({ id: 'KEYA-2', title: 'Done task', column: 'done', extra: `completed: '2026-10-02T00:00:00.000Z'\n${outputs}` }));
  const msgs = ofRule(lintAll(), 'TASK-OUTPUT').map((f) => f.message).sort();
  assert.deepEqual(msgs, ['outputs에 같은 경로가 두 번 있다: records/alpha/KEYA-2/discovery.md', '산출물 경로에 파일이 없다: records/alpha/KEYA-2/nope.md']);
});

test('TASK-DATE: 따옴표 없는 시각은 오류, 종료 컬럼의 completed 누락은 경고', () => {
  fx.write('board/tasks/KEYA-1.md', fx.read('board/tasks/KEYA-1.md').replace("created: '2026-10-01T00:00:00.000Z'", 'created: 2026-10-01T00:00:00.000Z'));
  fx.write('board/tasks/KEYA-2.md', boardTask({ id: 'KEYA-2', title: 'Done task', column: 'done' }));
  const r = lintAll();
  const [unquoted, missing] = ['error', 'warn'].map((s) => ofRule(r, 'TASK-DATE').find((f) => f.severity === s));
  assert.equal(unquoted.file, 'board/tasks/KEYA-1.md');
  assert.equal(missing.file, 'board/tasks/KEYA-2.md');
});

test('TASK-FIELD·TASK-FORMAT: 필수 필드 누락, 프론트매터 깨짐', () => {
  fx.write('board/tasks/KEYA-1.md', "---\ntask_id: KEYA-1\nproject: alpha\ntype: feature\ncolumn: backlog\nauthor: tester\ncreated: '2026-10-01T00:00:00.000Z'\n---\n");
  fx.write('board/tasks/KEYA-7.md', '---\ntitle: [\n---\n');
  const r = lintAll();
  assert.deepEqual(ofRule(r, 'TASK-FIELD').map((f) => f.message), ['title가 없다']);
  assert.equal(ofRule(r, 'TASK-FORMAT')[0].file, 'board/tasks/KEYA-7.md');
});

test('TASK-FIELD: 작성자(author)가 없거나 빈 이슈', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task' }).replace('author: tester\n', ''));
  fx.write('board/tasks/KEYA-3.md', boardTask({ id: 'KEYA-3', title: 'Empty author' }).replace('author: tester', "author: ''"));
  const f = ofRule(lintAll(), 'TASK-FIELD');
  assert.deepEqual(f.map((x) => [x.file, x.message]), [['board/tasks/KEYA-1.md', 'author가 없다'], ['board/tasks/KEYA-3.md', 'author가 없다']]);
  assert.equal(f[0].owner, 'board');
});

test('TSV-REMOTE(옛 TSV-GITLAB): remote 열 누락과 항목 수 불일치', () => {
  fx.write('projects.tsv', '# project\tkey\trepos\tgitlab\nalpha\tKEYA\torg/alpha-repo\nbeta\tKEYB\torg/alpha-repo,org/beta-repo\tgrp/alpha-repo\ncommon\tKEYC\t-\t-\n');
  const found = ofRule(lintAll(), 'TSV-REMOTE');
  assert.ok(found.every((f) => f.alias === 'TSV-GITLAB'));
  const msgs = found.map((f) => [f.line, f.message]);
  assert.deepEqual(msgs, [[2, "project 'alpha' 행에 remote 열(넷째 열)이 없다"], [3, "project 'beta'의 remote 항목 수가 repos(2개)와 다르다"]]);
});

test('CONFIG-SHARED: 공유 설정의 잘못된 값은 오류, 모르는 키는 경고, 파일이 없거나 비어 있으면 통과', () => {
  assert.deepEqual(ofRule(lintAll(), 'CONFIG-SHARED'), []);
  fx.write('workbench.config.json', '{}\n');
  assert.deepEqual(ofRule(lintAll(), 'CONFIG-SHARED'), []);
  fx.write('workbench.config.json', JSON.stringify({ host: { type: 'bitbucket' }, branch: 'a b', docRoots: ['../x'], board: { fetchIntervalSec: 1 }, extra: 1 }));
  const found = ofRule(lintAll(), 'CONFIG-SHARED').map((f) => [f.severity, f.message.split(':')[0]]).sort();
  assert.deepEqual(found, [
    ['error', 'board.fetchIntervalSec는 5 이상의 정수(초)다'],
    ['error', 'branch는 브랜치 이름이다'],
    ['error', 'docRoots는 저장소 안의 상대 경로 목록이다 (예'],
    ['error', 'host.type은 gitlab 또는 github다'],
    ['warn', '이 엔진이 모르는 키다(오타이거나 더 새 엔진의 키)'],
  ]);
  fx.write('workbench.config.json', '{"host": {"type": "gitlab"}}');
  assert.match(ofRule(lintAll(), 'CONFIG-SHARED')[0].message, /host.web/);
});

test('BOARD-CONFIG: board.yml 형식 오류는 오류, 설명에 없는 컬럼은 경고', () => {
  fx.write('board/board.yml', 'columns:\n  - {id: backlog, label: 📋 Backlog, state: started}\n');
  const bad = ofRule(lintAll(), 'BOARD-CONFIG');
  assert.equal(bad[0].severity, 'error');
  assert.match(bad[0].fix.join('\n'), /state 'started'/);
  fx.write('board/board.yml', 'columns:\n  - {id: backlog, label: 📋 Backlog, state: waiting}\n  - {id: done, label: ✅ Done, state: closed}\ndescription: |\n  📋 Backlog 착수 전\n');
  const warn = ofRule(lintAll(), 'BOARD-CONFIG');
  assert.deepEqual(warn.map((f) => [f.severity, f.message]), [['warn', "컬럼 '✅ Done'이 description의 워크플로 설명에 없다"]]);
});

test('task 본문 링크는 task 파일 기준으로 푼다', () => {
  fx.write('board/tasks/KEYA-2.md', boardTask({ id: 'KEYA-2', title: 'Done task', column: 'done', extra: "completed: '2026-10-02T00:00:00.000Z'\n", body: '[기록](../../records/alpha/KEYA-2/discovery.md) [옛 기준](../records/alpha/KEYA-2/discovery.md)\n' }));
  const broken = ofRule(lintAll(), 'LINK-BROKEN');
  assert.deepEqual(broken.map((f) => f.message), ['링크 대상이 없다: ../records/alpha/KEYA-2/discovery.md']);
});

test('LINK-REMOVED: 기록의 마지막 커밋에 있던 workbench 파일이 지워졌으면 경고, 없던 파일이면 오류', () => {
  const sh = (...a) => spawnSync('git', a, { cwd: fx.wb, encoding: 'utf8' });
  fx.write('site/old.js', '// x\n');
  fx.write('records/alpha/KEYA-2/discovery.md', `${fx.read('records/alpha/KEYA-2/discovery.md')}\n[옛 코드](../../../site/old.js) [없던 코드](../../../site/never.js)\n`);
  sh('add', '-A');
  sh('commit', '-qm', 'record with link');
  sh('rm', '-q', 'site/old.js');
  sh('commit', '-qm', 'remove old.js');
  const r = lintAll();
  assert.deepEqual(ofRule(r, 'LINK-REMOVED').map((f) => [f.severity, f.message.split(': ').at(-1)]), [['warn', '../../../site/old.js']]);
  assert.deepEqual(ofRule(r, 'LINK-BROKEN').map((f) => f.message), ['링크 대상이 없다: ../../../site/never.js']);
  // 대상을 지운 뒤 기록을 고쳐 커밋해도(마지막 커밋에는 대상이 없다) 경고로 남는다
  fx.write('records/alpha/KEYA-2/discovery.md', `${fx.read('records/alpha/KEYA-2/discovery.md')}- [x] 체크\n`);
  sh('commit', '-qam', 'edit record after removal');
  assert.deepEqual(ofRule(lintAll(), 'LINK-REMOVED').map((f) => f.severity), ['warn']);
});

test('LINK-ANCHOR: workbench 문서의 없는 앵커는 오류. 제목 slug·명시 앵커·코드 안 링크는 통과', () => {
  const fm = fx.read('records/alpha/KEYA-2/discovery.md').split('# d')[0];
  fx.write('records/alpha/KEYA-2/discovery.md', `${fm}# d\n\n## 2.1 gate와 결정 요청\n\n| <a id="O-12"></a>O-12 | 허용 목록 |\n\n`
    + '[제목](#21-gate와-결정-요청) [미결](#O-12) [없음](#O-99) `[코드](#nope)`\n');
  fx.write('board/tasks/KEYA-2.md', boardTask({ id: 'KEYA-2', title: 'Done task', column: 'done',
    extra: "completed: '2026-10-02T00:00:00.000Z'\noutputs:\n  - kind: 조사\n    path: records/alpha/KEYA-2/discovery.md\n",
    body: '[미결](../../records/alpha/KEYA-2/discovery.md#O-12) [옛 제목](../../records/alpha/KEYA-2/discovery.md#21-gate-기준)\n' }));
  const found = ofRule(lintAll(), 'LINK-ANCHOR').map((f) => [f.severity, f.file, f.message.split(': ')[0]]).sort();
  assert.deepEqual(found, [
    ['error', 'board/tasks/KEYA-2.md', "링크 앵커 '#21-gate-기준'가 records/alpha/KEYA-2/discovery.md에 없다"],
    ['error', 'records/alpha/KEYA-2/discovery.md', "링크 앵커 '#O-99'가 이 문서에 없다"],
  ]);
});

test('LINK-ANCHOR-ID: ID 항목 제목을 slug로 가리키면 경고하고 ID 앵커를 안내한다', () => {
  const fm = fx.read('records/alpha/KEYA-2/discovery.md').split('# d')[0];
  fx.write('records/alpha/KEYA-2/discovery.md', `${fm}# d\n\n### D-1 조사 범위를 정하는가\n\n### <a id="D-2"></a>D-2 원인을 단정하는가\n\n`
    + '[범위](#d-1-조사-범위를-정하는가) [원인](#d-2-원인을-단정하는가) [원인](#D-2)\n');
  const found = ofRule(lintAll(), 'LINK-ANCHOR-ID').map((f) => [f.severity, f.fix[0]]);
  assert.deepEqual(found, [
    ['warn', `대상 제목(records/alpha/KEYA-2/discovery.md:12)에 <a id="D-1"></a>를 넣고 '#D-1'로 링크한다`],
    ['warn', "'#D-2'로 링크한다"],
  ]);
});

test('TASK-ARCHIVED: 보관 표시는 종료 컬럼에서 true만', () => {
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task', extra: 'archived: true\n' }));
  fx.write('board/tasks/KEYA-2.md', boardTask({ id: 'KEYA-2', title: 'Done task', column: 'done', extra: "completed: '2026-10-02T00:00:00.000Z'\narchived: yes\n" }));
  const msgs = ofRule(lintAll(), 'TASK-ARCHIVED').map((f) => `${f.file} ${f.message}`).sort();
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /KEYA-1\.md 보관된 이슈가 종료 컬럼에 있지 않다/);
  assert.match(msgs[1], /KEYA-2\.md archived는 true만/);
});

test('TASK-MOVE-UNRECORDED: --staged에서 손으로 바꾼 column만 경고한다', () => {
  const stage = (...files) => spawnSync('git', ['add', ...files], { cwd: fx.wb });
  const staged = () => cli(fx, 'lint', ['--staged'], { json: true }).json;

  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Alpha task', column: 'in-progress' }));
  stage('board/tasks/KEYA-1.md');
  const [f] = ofRule(staged(), 'TASK-MOVE-UNRECORDED');
  assert.equal(f.severity, 'warn');
  assert.match(f.fix[0], /wb move-task KEYA-1 in-progress/);
  assert.equal(ofRule(cli(fx, 'lint', ['--changed'], { json: true }).json, 'TASK-MOVE-UNRECORDED').length, 0);
  assert.equal(ofRule(lintAll(), 'TASK-MOVE-UNRECORDED').length, 0);

  // move-task로 옮기면 history가 있어 경고하지 않는다
  spawnSync('git', ['reset', '-q', '--hard'], { cwd: fx.wb });
  assert.equal(cli(fx, 'move-task', ['KEYA-1', 'in-progress']).code, 0);
  fx.write('board/tasks/KEYA-9.md', boardTask({ id: 'KEYA-9', title: 'New one' }));
  stage('board/tasks/KEYA-1.md', 'board/tasks/KEYA-9.md');
  assert.equal(ofRule(staged(), 'TASK-MOVE-UNRECORDED').length, 0);
});
