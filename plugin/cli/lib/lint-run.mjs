// lint 실행부. lint 명령과 sync(커밋 전 검사)가 같은 프로세스에서 함께 쓴다
import path from 'node:path';
import { OWNER } from './report.mjs';
import { WB, git, posix, exists, cmdline } from './workbench.mjs';
import { runRules, frozenSinceClose } from './lint-rules.mjs';

function gitPaths(argsList) {
  const r = git(argsList);
  return r.stdout.split('\0').filter(Boolean);
}

function changedFiles() {
  const entries = gitPaths(['status', '--porcelain', '-z', '--untracked-files=all']);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    out.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // 이름 바꾸기는 다음 항목이 원래 이름
  }
  return out;
}

/**
 * @param {{mode: 'changed'|'staged'|'all'|'files', positionals?: string[], quiet?: boolean}} opts
 * @return {{exit: number, data: object, text: string}}
 */
export function lintRun({ mode, positionals = [], quiet = false }) {
  const values = { quiet };
  let targets = null;
  if (mode === 'changed') targets = changedFiles();
  if (mode === 'staged') targets = gitPaths(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMRD']);
  // workbench 기준 경로(records/...)를 먼저 보고, 없으면 현재 폴더 기준으로 푼다
  if (mode === 'files') targets = positionals.map((p) => posix(path.relative(WB, exists(path.resolve(WB, p)) ? path.resolve(WB, p) : path.resolve(p))));
  const targetSet = targets && new Set(targets);
  const hit = (p) => targetSet.has(p) || (p.endsWith('/') && targets.some((t) => t.startsWith(p)));

  // pre-commit: 스테이징된 이슈 파일의 HEAD·인덱스 내용 (TASK-MOVE-UNRECORDED)
  const show = (spec) => { const r = git(['show', spec]); return r.ok ? r.stdout : null; };
  const staged = mode === 'staged'
    ? targets.filter((t) => /^board\/tasks\/[^/]+\.md$/.test(t)).map((t) => ({ rel: t, head: show(`HEAD:${t}`), index: show(`:${t}`) }))
    : [];
  const all = runRules({ staged });
  const shown = [];
  const hidden = { error: 0, warn: 0 };
  for (const f of all) {
    const isTarget = !targetSet || hit(f.file) || f.related.some(hit);
    if (f.rule === 'REC-FROZEN') {
      if (targetSet) {
        if (!isTarget) continue;
        f.message += ` — 이번 변경이 동결된 기록을 건드린다: ${f.related.filter(hit).join(', ')}`;
      } else {
        const log = frozenSinceClose(f);
        if (!log) continue;
        f.message += ` — 종료 후 커밋 ${log.length}건: ${log[0]}${log.length > 1 ? ' 외' : ''}`;
      }
    }
    delete f.frozen;
    if (isTarget) shown.push(f);
    else hidden[f.severity]++;
  }
  const visible = values.quiet ? shown.filter((f) => f.severity === 'error') : shown;
  const errors = shown.filter((f) => f.severity === 'error').length;
  const warns = shown.length - errors;

  const scope = targetSet ? `${mode} — 대상 파일 ${targets.length}개` : 'all — 전체';
  const head = `lint (${scope}): 오류 ${errors}건, 경고 ${warns}건` +
    (hidden.error + hidden.warn ? ` / 대상 밖 기존 위반 오류 ${hidden.error}건·경고 ${hidden.warn}건은 숨김 (전체 보기: wb lint --all)` : '');
  const body = visible
    .sort((a, b) => (a.severity === b.severity ? a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) : a.severity === 'error' ? -1 : 1))
    .map((f) => [
      `${f.severity === 'error' ? '오류' : '경고'} [${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''}`,
      `  문제: ${f.message}`,
      ...f.fix.map((x, i) => `  ${i === 0 ? '수정' : '    '}: ${x}`),
      `  누가: ${OWNER[f.owner]}`,
    ].join('\n'));
  const tail = errors
    ? `결과: 거부 — 오류 ${errors}건. "누가"가 에이전트인 항목을 고치고, 나머지는 사용자에게 보고한 뒤 다시 실행한다: ${cmdline()}`
    : `결과: 통과${warns ? ` — 경고 ${warns}건은 막지 않는다. 고칠 수 있으면 고치고, 아니면 보고에 남긴다` : ''}`;

  return {
    exit: errors ? 1 : 0,
    data: { ok: errors === 0, mode, targets, errors, warnings: warns, hidden, findings: visible.map((f) => ({ ...f, ownerText: OWNER[f.owner] })) },
    text: [head, ...body, tail].join('\n\n'),
  };
}
