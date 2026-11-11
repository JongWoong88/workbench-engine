// decisions.md(이슈 하나의 agent 결정과 담당자 평가) 파서·집계·검사.
// 형식의 정본: plugin/references/decisions-format.md
import { parseFrontmatter } from './workbench.mjs';

export const STAGES = ['discovery', 'proposal', 'design', 'planning'];
// '하'는 2026-10-30 이전 기록을 읽기 위해서만 받는다. 새 기록은 상·중만 쓴다
export const IMPACTS = ['상', '중', '하'];
export const EVALUATIONS = ['승인', '수정', '누락', '제외(불필요)', '제외(판정 불가)'];
export const SUMMARY_COLUMNS = ['D', '단계', '결정할 것', '채택안', '영향도', '평가', '하네스'];
// 2026-10-30 이전 기록의 마지막 열 이름. 읽기만 한다
const LEGACY_COLUMNS = [...SUMMARY_COLUMNS.slice(0, -1), '프레임'];

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isTableLine = (line) => line.trim().startsWith('|');
const isSeparator = (line) => /^\|?\s*:?-{3,}/.test(line.trim());

/**
 * decisions.md 본문을 읽는다. 형식을 벗어난 부분은 버리지 않고 problems에 줄 번호와 함께 남긴다.
 * @returns {{status, progress: string[]|null, progressLine, items: object[], details: Map, problems: {line:number, message:string}[]}}
 */
export function parseDecisions(text) {
  const fm = parseFrontmatter(text);
  const lines = fm.body.split('\n');
  const lineNo = (i) => fm.bodyLine + i;
  const problems = [];
  const problem = (i, message) => problems.push({ line: lineNo(i), message });

  let status = null;
  let progress = null;
  let progressLine = null;
  let section = null;
  let headerSeen = false;
  let detail = null;
  const items = [];
  const details = new Map();

  lines.forEach((line, i) => {
    const h2 = /^## (.+)$/.exec(line);
    if (h2) { section = h2[1].trim(); detail = null; return; }

    if (section === null) {
      const st = /^평가 상태:\s*(.*)$/.exec(line);
      if (st) {
        const v = st[1].trim();
        const done = /^평가 완료\s*\((\d{4}-\d{2}-\d{2}),\s*(.+)\)$/.exec(v); // 평가자에 괄호가 들어갈 수 있다
        if (v === '평가 전') status = { state: '평가 전', line: lineNo(i) };
        else if (done) status = { state: '평가 완료', date: done[1], evaluator: done[2].trim(), line: lineNo(i) };
        else problem(i, `평가 상태 값 '${v}'를 읽을 수 없다. '평가 전' 또는 '평가 완료 (YYYY-MM-DD, 평가자)'로 쓴다`);
      }
      const pr = /^진행:\s*(.*)$/.exec(line);
      if (pr) {
        progress = pr[1].split(',').map((s) => s.trim()).filter(Boolean);
        progressLine = lineNo(i);
      }
      return;
    }

    if (section === '요약' && isTableLine(line)) {
      if (isSeparator(line)) return;
      const c = cells(line);
      if (!headerSeen) {
        headerSeen = true;
        if (![SUMMARY_COLUMNS, LEGACY_COLUMNS].some((cols) => c.join('|') === cols.join('|'))) problem(i, `요약 표의 열이 [${c.join(', ')}]다. [${SUMMARY_COLUMNS.join(', ')}] 순서로 둔다`);
        return;
      }
      if (c.length !== SUMMARY_COLUMNS.length) { problem(i, `요약 표 행의 열이 ${c.length}개다. ${SUMMARY_COLUMNS.length}개(${SUMMARY_COLUMNS.join(', ')})여야 한다`); return; }
      const [id, stage, question, choice, impactCell, evaluation, harness] = c;
      if (!/^D-\d+$/.test(id)) { problem(i, `D 값 '${id}'가 D-n 형식이 아니다`); return; }
      if (!STAGES.includes(stage)) problem(i, `${id} 단계 값 '${stage}'가 ${STAGES.join('·')} 중 하나가 아니다`);
      const im = new RegExp(`^(${IMPACTS.join('|')})(?:→(${IMPACTS.join('|')}))?$`).exec(impactCell);
      if (!im) problem(i, `${id} 영향도 값 '${impactCell}'가 상·중·하 또는 '중→상' 형식이 아니다`);
      if (evaluation && !EVALUATIONS.includes(evaluation)) problem(i, `${id} 평가 값 '${evaluation}'가 ${EVALUATIONS.join(' · ')} 또는 빈칸이 아니다`);
      // 하네스: 설치 버전(wb --version, 예 1.2.0). 분리 전 기록은 workbench 커밋 7자리다
      if (!/^([0-9a-f]{7,40}|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|—|-)$/.test(harness)) problem(i, `${id} 하네스 값 '${harness}'가 설치 버전(예 1.2.0), 커밋 7자리, '—' 중 하나가 아니다`);
      items.push({
        id, stage, question, choice,
        impact: im ? (im[2] ?? im[1]) : null,
        impactOriginal: im ? im[1] : null,
        evaluation: evaluation || null, harness, line: lineNo(i),
      });
      return;
    }

    if (section === '상세') {
      const h3 = /^### (D-\d+)\b/.exec(line);
      if (h3) { detail = { line: lineNo(i), redone: [] }; details.set(h3[1], detail); return; }
      const rd = /^- 다시 만든 단계:\s*(.*)$/.exec(line);
      if (rd && detail) detail.redone = rd[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
  });

  return { status, progress, progressLine, items, details, problems };
}

function tally(items) {
  const count = (v) => items.filter((x) => x.evaluation === v).length;
  const missed = count('누락');
  const revised = count('수정');
  const approved = count('승인');
  const unneeded = count('제외(불필요)');
  const undecidable = count('제외(판정 불가)');
  const recorded = items.length - missed;
  const decisions = approved + revised;
  const ratio = (a, b) => (b ? a / b : 0);
  return {
    recorded, missed, revised, approved, unneeded, undecidable,
    missRate: ratio(missed, decisions + missed),
    reviseRate: ratio(revised, decisions),
    overRate: ratio(unneeded, recorded - undecidable),
    highMissed: items.filter((x) => x.evaluation === '누락' && x.impact === '상').length,
    highRevised: items.filter((x) => x.evaluation === '수정' && x.impact === '상').length,
    redoneStages: items.reduce((n, x) => n + x.redone, 0),
  };
}

/**
 * 지표(정의의 정본은 bin/decision-stats.mjs 머리 주석). 영향도는 담당자 값을 쓴다.
 * @param {ReturnType<typeof parseDecisions>|ReturnType<typeof parseDecisions>[]} parsed 하나 또는 여럿
 */
export function decisionStats(parsed, { byHarness = false } = {}) {
  const items = [].concat(parsed).flatMap((p) => p.items.map((x) => ({ ...x, redone: p.details.get(x.id)?.redone.length ?? 0 })));
  const result = tally(items);
  if (byHarness) {
    result.harnesses = {};
    for (const h of new Set(items.map((x) => x.harness))) result.harnesses[h] = tally(items.filter((x) => x.harness === h));
  }
  return result;
}

/**
 * 형식 대응 검사. 집계를 믿을 수 있는지 본다.
 * @param {ReturnType<typeof parseDecisions>} p
 * @param {{docs: {file:string, text:string}[]}} o 같은 이슈 폴더의 다른 산출물 (본문의 D-n 링크 대조용)
 * @returns {{line:number|null, message:string}[]}
 */
export function checkDecisions(p, { docs = [] } = {}) {
  const errors = [...p.problems];
  const err = (line, message) => errors.push({ line: line ?? null, message });

  if (!p.status) err(null, "머리 줄 '평가 상태:'가 없다. H1 아래 첫 줄에 '평가 상태: 평가 전'을 둔다");
  if (!p.progress) err(null, "머리 줄 '진행:'이 없다. '평가 상태:' 다음 줄에 '진행: '(끝난 단계 컬럼 id)을 둔다");
  else {
    const bad = p.progress.filter((s) => !STAGES.includes(s));
    if (bad.length) err(p.progressLine, `진행 줄의 '${bad.join(', ')}'가 단계 컬럼 id(${STAGES.join(', ')})가 아니다`);
    const idx = p.progress.filter((s) => STAGES.includes(s)).map((s) => STAGES.indexOf(s));
    if (idx.some((v, k) => k > 0 && v <= idx[k - 1])) err(p.progressLine, `진행 줄이 컬럼 순서(${STAGES.join(', ')})가 아니거나 중복이 있다: ${p.progress.join(', ')}`);
  }

  const seenId = new Map();
  const seenKey = new Map();
  for (const x of p.items) {
    if (seenId.has(x.id)) err(x.line, `${x.id}가 요약 표에 두 번 있다(${seenId.get(x.id)}행). 번호는 하나만 쓴다`);
    seenId.set(x.id, x.line);
    const key = `${x.stage}|${x.question}`;
    if (seenKey.has(key)) err(x.line, `${x.id}의 결정 키(단계 ${x.stage} + '${x.question}')가 ${seenKey.get(key)}와 같다. 같은 결정이면 기존 항목을 고치고 이 행을 지운다`);
    else seenKey.set(key, x.id);
    if (!p.details.has(x.id)) err(x.line, `${x.id}의 상세 절('### ${x.id} …')이 없다`);
    if (p.status?.state === '평가 완료' && !x.evaluation) err(x.line, `평가 상태가 평가 완료인데 ${x.id}의 평가가 비어 있다`);
  }
  for (const [id, d] of p.details) if (!seenId.has(id)) err(d.line, `상세 절 ${id}가 요약 표에 없다`);

  for (const doc of docs) {
    for (const m of doc.text.matchAll(/\[(D-\d+)\]\(decisions\.md(?:#[^)]*)?\)/g)) {
      if (!seenId.has(m[1])) err(null, `${doc.file}이 링크한 ${m[1]}가 요약 표에 없다`);
    }
  }
  return errors;
}
