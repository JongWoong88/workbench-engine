#!/usr/bin/env node
// workbench 규칙 검사. 오류가 있으면 종료 코드 1.
//   검사 대상(--changed 기본, --staged, --files, --all)과 겹치는 위반만 보인다.
//   대상 밖의 기존 위반은 건수만 알린다 — 처음 도입할 때 기존 위반이 많아도 바꾼 파일은 깨끗하게 유지하기 위함이다.
import { run, args, usage } from './lib/report.mjs';
import { lintRun } from './lib/lint-run.mjs';

const USAGE = `사용법: wb lint [--changed | --staged | --all | --files <파일> …] [--quiet] [--json]
  --changed  (기본) 커밋하지 않은 변경 파일(새 파일 포함)
  --staged   스테이징된 파일 (pre-commit hook)
  --files    지정한 파일 (스킬이 자기가 만든 파일을 검사할 때)
  --all      전체. 기존 위반까지 모두 보인다
  --quiet    경고를 숨긴다`;

run(async () => {
  const { values, positionals } = args({
    changed: { type: 'boolean' }, staged: { type: 'boolean' }, all: { type: 'boolean' }, files: { type: 'boolean' }, quiet: { type: 'boolean' },
  }, USAGE);
  const modes = ['changed', 'staged', 'all', 'files'].filter((m) => values[m]);
  if (modes.length > 1) throw usage(`--${modes.join(', --')}는 함께 쓸 수 없다`, USAGE);
  const mode = modes[0] ?? (positionals.length ? 'files' : 'changed');
  if (mode !== 'files' && positionals.length) throw usage('파일을 지정하려면 --files를 쓴다', USAGE);
  if (mode === 'files' && !positionals.length) throw usage('--files 뒤에 파일을 하나 이상 지정한다', USAGE);

  return lintRun({ mode, positionals, quiet: values.quiet });
}, USAGE);
