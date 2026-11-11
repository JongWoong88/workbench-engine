// 호환 규칙: 엔진을 갱신해도 문서 저장소를 고치지 않는다(K-2·K-3), 새 형식의 문서 저장소는 옛 엔진이 고치지 않는다(K-8),
// 결정 기록의 하네스 값은 설치 버전이고 분리 전 커밋 값도 읽는다(D-15)
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, cli, boardTask } from './fixture.mjs';
import { applySince } from '../plugin/cli/lib/lint-rules.mjs';
import { FORMAT_VERSION } from '../plugin/cli/lib/shared-config.mjs';
import { parseDecisions } from '../plugin/cli/lib/decisions.mjs';
import { effectiveAuthor } from '../plugin/cli/lib/model/board.mjs';

test('K-3: 문서 저장소 형식 버전보다 늦게 생긴 오류 규칙은 경고로 낮추고 이유를 덧붙인다', () => {
  const f = (rule, severity = 'error') => ({ rule, severity, fix: ['고친다'] });
  const out = applySince([f('NEW-RULE'), f('OLD-RULE'), f('NEW-RULE', 'warn')], 1, { 'NEW-RULE': 2 });
  assert.deepEqual(out.map((x) => x.severity), ['warn', 'error', 'warn']);
  assert.equal(out[0].since, 2);
  assert.match(out[0].fix.at(-1), /formatVersion을 2로 올리면/);
  // 형식 버전을 올린 문서 저장소에서는 오류다
  assert.equal(applySince([f('NEW-RULE')], 2, { 'NEW-RULE': 2 })[0].severity, 'error');
});

test('K-2: author가 없는 이슈는 history 첫 항목의 작성자를 쓴다', () => {
  assert.equal(effectiveAuthor({ author: 'a', history: [{ author: 'b' }] }), 'a');
  assert.equal(effectiveAuthor({ history: [{ type: 'created', author: 'b' }] }), 'b');
  assert.equal(effectiveAuthor({ history: [] }), null);
  assert.equal(effectiveAuthor({}), null);
});

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

const noAuthor = (history) => boardTask({ id: 'KEYA-1', title: 'Old', extra: '' }).replace('author: tester\n', '').replace('history: []', history);

test('K-2: author 필드가 생기기 전 이슈는 lint를 통과하고 find-task가 작성자를 보여 준다', () => {
  fx.write('board/tasks/KEYA-1.md', noAuthor("history:\n  - type: created\n    date: '2026-10-01T00:00:00.000Z'\n    author: Old Writer\n    column: backlog"));
  const lint = cli(fx, 'lint', ['--all'], { json: true });
  assert.equal(lint.json.findings.filter((f) => f.rule === 'TASK-FIELD').length, 0, JSON.stringify(lint.json.findings));
  assert.equal(cli(fx, 'find-task', ['KEYA-1'], { json: true }).json.task.author, 'Old Writer');
  // 이력에도 작성자가 없으면 여전히 필수 필드 누락이다
  fx.write('board/tasks/KEYA-1.md', noAuthor('history: []'));
  assert.deepEqual(cli(fx, 'lint', ['--all'], { json: true }).json.findings.filter((f) => f.rule === 'TASK-FIELD').map((f) => f.message), ['author가 없다']);
});

test('K-8: 문서 저장소 형식 버전이 엔진보다 높으면 문서를 쓰는 명령은 종료 코드 3으로 멈춘다', () => {
  fx.write('workbench.config.json', JSON.stringify({ formatVersion: FORMAT_VERSION + 1 }));
  const r = cli(fx, 'find-task', ['KEYA-1'], { json: true });
  assert.equal(r.code, 3, r.out + r.err);
  assert.equal(r.json.code, 'ENV-FORMAT-NEWER');
  assert.match(r.json.fix[0], /플러그인을 갱신/);
  assert.equal(cli(fx, 'lint', ['--all'], { json: true }).code, 3);
  // 설정 확인은 막지 않는다
  assert.equal(cli(fx, 'config', ['get'], { json: true }).code, 0);
  // 같은 버전이면 통과
  fx.write('workbench.config.json', JSON.stringify({ formatVersion: FORMAT_VERSION }));
  assert.equal(cli(fx, 'find-task', ['KEYA-1'], { json: true }).code, 0);
});

const HEADER = '| D | 단계 | 결정할 것 | 채택안 | 영향도 | 평가 | 하네스 |\n|---|---|---|---|---|---|---|\n';
const doc = (rows) => `# t\n\n평가 상태: 평가 전\n진행:\n\n## 요약\n\n${HEADER}${rows}\n## 상세\n`;

test('D-15: 하네스 값은 설치 버전과 분리 전 커밋을 함께 받는다', () => {
  const p = parseDecisions(doc('| D-1 | design | a | b | 상 |  | 1.2.0 |\n| D-2 | design | c | d | 상 |  | 0.0.0-dev |\n| D-3 | design | e | f | 상 |  | bbd7f6a |\n'));
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.items.map((x) => x.harness), ['1.2.0', '0.0.0-dev', 'bbd7f6a']);
  assert.match(parseDecisions(doc('| D-1 | design | a | b | 상 |  | v1 |\n')).problems[0].message, /설치 버전/);
});

test('wb --version은 설치 버전을 출력한다', () => {
  const wb = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'bin', 'wb.mjs');
  const r = spawnSync(process.execPath, [wb, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
