// decisions.md 파서·집계·검사와 decision-stats 명령. 형식: plugin/references/decisions-format.md
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorkspace, cli } from './fixture.mjs';
import { parseDecisions, decisionStats, checkDecisions } from '../plugin/cli/lib/decisions.mjs';

const FM = (task = 'KEYA-1') => `---\ntitle: Alpha task 결정 기록\nlifecycle: record\ntask_id: ${task}\nrepos: []\nbase: none\nupdated: 2026-11-02\n---\n\n`;

const HEADER = '| D | 단계 | 결정할 것 | 채택안 | 영향도 | 평가 | 하네스 |\n|---|---|---|---|---|---|---|\n';

/** 평가 완료: 기록 4(승인 2, 수정 2), 누락 1. 수정 하나는 담당자가 중→상으로 올렸다 */
const EVALUATED = `${FM()}# Alpha task 결정 기록

평가 상태: 평가 완료 (2026-11-02, 담당자)
진행: discovery, proposal, design, planning

## 요약

${HEADER}| D-1 | discovery | 조사 범위에 배치를 넣는가 | 넣는다 | 중 | 승인 | aaaaaaa |
| D-2 | proposal | 당일을 포함하는가 | 포함 | 중→상 | 수정 | aaaaaaa |
| D-3 | proposal | 문구를 누가 정하는가 |  | 상 | 누락 | aaaaaaa |
| D-4 | design | 캐시를 쓰는가 | 쓴다 | 하 | 승인 | bbbbbbb |
| D-5 | planning | 테스트를 나누는가 | 나눈다 | 하 | 수정 | bbbbbbb |

## 상세

### D-1 조사 범위에 배치를 넣는가

- 평가: 승인 · 담당자 · 2026-11-02

### D-2 당일을 포함하는가

- 평가: 수정 · 담당자 · 2026-11-02 — 다음 날부터
- 다시 만든 단계: design, planning

### D-3 문구를 누가 정하는가

- 평가: 누락 · 담당자 · 2026-11-02

### D-4 캐시를 쓰는가

- 평가: 승인 · 담당자 · 2026-11-02

### D-5 테스트를 나누는가

- 평가: 수정 · 담당자 · 2026-11-02
- 다시 만든 단계: planning
`;

const PENDING = `${FM('KEYA-3')}# Pending 결정 기록

평가 상태: 평가 전
진행: discovery

## 요약

${HEADER}| D-1 | discovery | 범위를 넓히는가 | 넓힌다 | 중 |  | ccccccc |

## 상세

### D-1 범위를 넓히는가

- 근거: x
`;

test('parse: 머리 두 줄, 요약 표, 상세의 다시 만든 단계를 읽는다', () => {
  const p = parseDecisions(EVALUATED);
  assert.equal(p.status.state, '평가 완료');
  assert.equal(p.status.date, '2026-11-02');
  assert.deepEqual(p.progress, ['discovery', 'proposal', 'design', 'planning']);
  assert.equal(p.items.length, 5);
  assert.deepEqual(p.items[1], { id: 'D-2', stage: 'proposal', question: '당일을 포함하는가', choice: '포함', impact: '상', impactOriginal: '중', evaluation: '수정', harness: 'aaaaaaa', line: p.items[1].line });
  assert.deepEqual(p.details.get('D-2').redone, ['design', 'planning']);
  assert.deepEqual(p.problems, []);
});

test('parse: 평가자 이름에 괄호가 있어도 평가 완료를 읽는다', () => {
  const p = parseDecisions(EVALUATED.replace('평가 완료 (2026-11-02, 담당자)', '평가 완료 (2026-11-02, 담당자·Claude(대조))'));
  assert.equal(p.status.state, '평가 완료');
  assert.equal(p.status.evaluator, '담당자·Claude(대조)');
});

test('stats: 누락률·수정률·상 누락·상 수정·재작성 단계를 정의대로 센다', () => {
  const s = decisionStats(parseDecisions(EVALUATED));
  // 기록 4 = 누락이 아닌 항목, 누락 1
  assert.equal(s.recorded, 4);
  assert.equal(s.missed, 1);
  assert.equal(s.revised, 2);
  assert.equal(s.approved, 2);
  assert.equal(s.missRate, 1 / 5); // 누락 ÷ (기록 + 누락)
  assert.equal(s.reviseRate, 2 / 4); // 수정 ÷ 기록
  assert.equal(s.highMissed, 1);
  assert.equal(s.highRevised, 1); // D-2는 담당자가 중→상으로 올렸으므로 상으로 센다
  assert.equal(s.redoneStages, 3);
});

test('stats: 제외(불필요)는 과잉률로, 제외(판정 불가)는 모든 비율에서 뺀다', () => {
  const text = EVALUATED
    .replace('| D-5 | planning |', '| D-6 | design | 메서드 이름을 무엇으로 하는가 | requireX | 중 | 제외(불필요) | bbbbbbb |\n| D-7 | discovery | 운영 DB를 조회하는가 | 한다 | 중 | 제외(판정 불가) | aaaaaaa |\n| D-5 | planning |')
    .replace('## 상세\n', '## 상세\n\n### D-6 메서드 이름을 무엇으로 하는가\n\n- 평가: 제외(불필요) · 담당자 · 2026-11-02\n\n### D-7 운영 DB를 조회하는가\n\n- 평가: 제외(판정 불가) · 담당자 · 2026-11-02\n');
  const p = parseDecisions(text);
  assert.deepEqual(p.problems, []);
  const s = decisionStats(p);
  assert.equal(s.recorded, 6); // agent가 기록한 항목(누락 제외)
  assert.equal(s.unneeded, 1);
  assert.equal(s.undecidable, 1);
  assert.equal(s.overRate, 1 / 5); // 불필요 ÷ (기록 − 판정 불가)
  assert.equal(s.missRate, 1 / 5); // 누락 ÷ (승인 + 수정 + 누락)
  assert.equal(s.reviseRate, 2 / 4); // 수정 ÷ (승인 + 수정)
  assert.deepEqual(checkDecisions(p, { docs: [] }), []);
});

test('stats: 하네스 버전별로 나눈다', () => {
  const s = decisionStats(parseDecisions(EVALUATED), { byHarness: true });
  assert.deepEqual(Object.keys(s.harnesses).sort(), ['aaaaaaa', 'bbbbbbb']);
  assert.equal(s.harnesses.aaaaaaa.recorded, 2);
  assert.equal(s.harnesses.aaaaaaa.missed, 1);
  assert.equal(s.harnesses.bbbbbbb.revised, 1);
});

test('parse: 열이 모자란 표와 허용되지 않은 값은 줄 번호와 함께 문제로 돌려준다', () => {
  const bad = EVALUATED
    .replace('| D-4 | design | 캐시를 쓰는가 | 쓴다 | 하 | 승인 | bbbbbbb |', '| D-4 | design | 캐시를 쓰는가 | 쓴다 | 매우 큼 | 보류 | bbbbbbb |')
    .replace('| D-5 | planning | 테스트를 나누는가 | 나눈다 | 하 | 수정 | bbbbbbb |', '| D-5 | planning | 테스트를 나누는가 |');
  const p = parseDecisions(bad);
  const msgs = p.problems.map((x) => x.message).join('\n');
  assert.match(msgs, /영향도/);
  assert.match(msgs, /평가/);
  assert.match(msgs, /열/);
  assert.ok(p.problems.every((x) => Number.isInteger(x.line)));
});

test('check: 요약 표와 상세 불일치, 중복 결정 키, 산출물의 없는 D-n, 순서가 틀린 진행 줄을 잡는다', () => {
  const broken = EVALUATED
    .replace('진행: discovery, proposal, design, planning', '진행: proposal, discovery')
    .replace('| D-5 | planning | 테스트를 나누는가 |', '| D-5 | design | 캐시를 쓰는가 |')
    .replace('### D-4 캐시를 쓰는가', '### D-9 캐시를 쓰는가');
  const errors = checkDecisions(parseDecisions(broken), {
    docs: [{ file: 'records/alpha/KEYA-1/design.md', text: '채택안 적용 ([D-2](decisions.md#d-2)), 없는 결정 ([D-7](decisions.md#d-7))' }],
  });
  const msgs = errors.map((e) => e.message).join('\n');
  assert.match(msgs, /진행/);
  assert.match(msgs, /결정 키/);
  assert.match(msgs, /D-4.*상세/);
  assert.match(msgs, /D-9/);
  assert.match(msgs, /D-7/);
  assert.doesNotMatch(msgs, /D-2[^0-9]/);
});

test('check: 평가 완료인데 평가가 빈 항목은 오류, 형식이 맞으면 오류 없음', () => {
  assert.deepEqual(checkDecisions(parseDecisions(EVALUATED), { docs: [] }), []);
  const unfinished = EVALUATED.replace('| 하 | 승인 | bbbbbbb |', '| 하 |  | bbbbbbb |');
  assert.match(checkDecisions(parseDecisions(unfinished), { docs: [] }).map((e) => e.message).join('\n'), /평가 완료/);
  assert.deepEqual(checkDecisions(parseDecisions(PENDING), { docs: [] }), []);
});

let fx;
beforeEach(() => {
  fx = makeWorkspace();
  fx.write('records/alpha/KEYA-1/decisions.md', EVALUATED);
  fx.write('records/alpha/KEYA-3/decisions.md', PENDING);
});
afterEach(() => fx.cleanup());

test('decision-stats: 평가 완료 문서만 집계하고, 평가 전 문서는 제외했다고 알린다', () => {
  const r = cli(fx, 'decision-stats', [], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json.issues.map((i) => i.task), ['KEYA-1']);
  assert.deepEqual(r.json.pending.map((i) => i.task), ['KEYA-3']);
  assert.equal(r.json.total.recorded, 4);
  const text = cli(fx, 'decision-stats', []);
  assert.match(text.out, /KEYA-1/);
  assert.match(text.out, /평가 전.*KEYA-3/s);
});

test('decision-stats: --task로 좁히고 --by harness로 나눈다', () => {
  const r = cli(fx, 'decision-stats', ['--task', 'KEYA-1', '--by', 'harness'], { json: true });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json.issues.length, 1);
  assert.equal(r.json.total.harnesses.bbbbbbb.revised, 1);
});

test('decision-stats --check: 형식 오류가 있으면 종료 코드 1과 파일·줄을 준다', () => {
  assert.equal(cli(fx, 'decision-stats', ['--check']).code, 0);
  fx.write('records/alpha/KEYA-3/proposal.md', '본문 ([D-4](decisions.md#d-4))\n');
  const r = cli(fx, 'decision-stats', ['--check', '--task', 'KEYA-3'], { json: true });
  assert.equal(r.code, 1);
  assert.equal(r.json.errors[0].file, 'records/alpha/KEYA-3/decisions.md');
  assert.match(r.json.errors[0].message, /D-4/);
});

test('decision-stats: 없는 task면 거부', () => {
  const r = cli(fx, 'decision-stats', ['--task', 'KEYA-9'], { json: true });
  assert.equal(r.code, 1);
  assert.equal(r.json.code, 'DECISIONS-NOT-FOUND');
});

test('parse: 예전 열 이름 프레임도 읽는다', () => {
  const p = parseDecisions(EVALUATED.replace('| 평가 | 하네스 |', '| 평가 | 프레임 |'));
  assert.deepEqual(p.problems, []);
  assert.equal(p.items[0].harness, 'aaaaaaa');
});
