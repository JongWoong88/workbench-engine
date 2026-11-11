#!/usr/bin/env node
// 이슈 폴더의 decisions.md(agent 결정과 담당자 평가)를 모아 지표를 내거나 형식을 검사한다.
// 형식: plugin/references/decisions-format.md
//   집계: 평가 완료 문서만. 영향도는 담당자 값(`중→상`의 `상`)
//     기록 = agent가 기록한 항목(누락이 아닌 것), 결정 = 승인 + 수정
//     누락률 = 누락 ÷ (결정 + 누락)          — 올렸어야 할 결정을 놓친 비율
//     수정률 = 수정 ÷ 결정                    — 채택안이 틀린 비율
//     과잉률 = 제외(불필요) ÷ (기록 − 제외(판정 불가)) — 올릴 필요가 없는 선택을 올린 비율
//     제외(판정 불가)는 세 비율 모두에서 뺀다
//   --check: 평가 상태와 관계없이 형식 대응을 검사한다. 오류가 있으면 종료 코드 1
import fs from 'node:fs';
import path from 'node:path';
import { run, args, usage, Rejection, EXIT } from './lib/report.mjs';
import { RECORDS, listFiles, read, rel, posix } from './lib/workbench.mjs';
import { parseDecisions, decisionStats, checkDecisions } from './lib/decisions.mjs';

const USAGE = `사용법: wb decision-stats [--task <task_id> | --project <project>] [--by harness] [--check]
  --task     그 이슈의 decisions.md만
  --project  그 project의 decisions.md만
  --by harness 하네스 버전(결정 당시 설치 버전, 분리 전 기록은 workbench 커밋)별로 나눠 센다. frame도 받는다(예전 이름)
  --check    형식만 검사한다 (요약 표↔상세, 결정 키 중복, 산출물의 D-n 링크, 진행 줄)`;

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const line = (s) => [
  `기록 ${s.recorded} (승인 ${s.approved} · 수정 ${s.revised} · 제외(불필요) ${s.unneeded} · 제외(판정 불가) ${s.undecidable}) · 누락 ${s.missed}`,
  `누락률 ${pct(s.missRate)} · 수정률 ${pct(s.reviseRate)} · 과잉률 ${pct(s.overRate)} · 상 누락 ${s.highMissed} · 상 수정 ${s.highRevised} · 재작성 단계 ${s.redoneStages}`,
].join('\n  ');

run(async () => {
  const { values } = args({ task: { type: 'string' }, project: { type: 'string' }, by: { type: 'string' }, check: { type: 'boolean' } }, USAGE, { positionals: false });
  if (values.task && values.project) throw usage('--task와 --project는 함께 쓸 수 없다', USAGE);
  if (values.by && !['harness', 'frame'].includes(values.by)) throw usage(`--by 값은 harness만 된다: ${values.by}`, USAGE);

  const files = listFiles(RECORDS)
    .filter((f) => path.basename(f) === 'decisions.md')
    .map((f) => ({ abs: f, file: rel(f), parts: posix(path.relative(RECORDS, f)).split('/') }))
    .filter((f) => f.parts.length === 3)
    .map((f) => ({ ...f, project: f.parts[0], task: f.parts[1] }))
    .filter((f) => (!values.task || f.task === values.task) && (!values.project || f.project === values.project));
  if (files.length === 0) {
    throw new Rejection({
      code: 'DECISIONS-NOT-FOUND',
      message: `${values.task ? `이슈 ${values.task}의 ` : values.project ? `project ${values.project}의 ` : ''}decisions.md가 없다`,
      fix: ['task_id·project 값을 확인한다', 'decisions.md는 결정을 처음 기록하는 스킬이 만든다(plugin/references/decisions-format.md "만들기"). 아직 결정 기록이 없는 이슈다'],
    });
  }

  const docs = files.map((f) => ({ ...f, parsed: parseDecisions(read(f.abs)) }));

  if (values.check) {
    const errors = docs.flatMap((d) => {
      const siblings = fs.readdirSync(path.dirname(d.abs))
        .filter((n) => n.endsWith('.md') && n !== 'decisions.md')
        .map((n) => ({ file: rel(path.join(path.dirname(d.abs), n)), text: read(path.join(path.dirname(d.abs), n)) }));
      return checkDecisions(d.parsed, { docs: siblings }).map((e) => ({ file: d.file, ...e }));
    });
    const text = errors.length
      ? [`검사: decisions.md ${docs.length}개, 오류 ${errors.length}건`, ...errors.map((e) => `오류 ${e.file}${e.line ? `:${e.line}` : ''}\n  ${e.message}`), '', '수정: 형식(plugin/references/decisions-format.md)에 맞게 고치고 다시 실행한다'].join('\n')
      : `검사: decisions.md ${docs.length}개, 오류 0건`;
    return { data: { checked: docs.map((d) => d.file), errors }, text, exit: errors.length ? EXIT.REJECTED : EXIT.OK };
  }

  const byHarness = Boolean(values.by);
  const evaluated = docs.filter((d) => d.parsed.status?.state === '평가 완료');
  const pending = docs.filter((d) => d.parsed.status?.state !== '평가 완료');
  const issues = evaluated.map((d) => ({ task: d.task, project: d.project, file: d.file, ...decisionStats(d.parsed, { byHarness }), warnings: d.parsed.problems }));
  const total = decisionStats(evaluated.map((d) => d.parsed), { byHarness });

  const text = [
    ...issues.map((i) => `${i.task} (${i.file})\n  ${line(i)}${i.warnings.length ? `\n  경고 ${i.warnings.length}건 — --check로 확인한다` : ''}`),
    evaluated.length ? `합계 (${evaluated.length}건)\n  ${line(total)}` : '평가를 마친 decisions.md가 없다',
    ...(byHarness ? Object.entries(total.harnesses).map(([h, s]) => `하네스 ${h}\n  ${line(s)}`) : []),
    ...(pending.length ? [`평가 전이라 제외: ${pending.map((d) => d.task).join(', ')}`] : []),
  ].join('\n');
  return { data: { issues, pending: pending.map((d) => ({ task: d.task, file: d.file })), total }, text };
}, USAGE);
