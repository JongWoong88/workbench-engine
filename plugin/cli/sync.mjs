#!/usr/bin/env node
// 이슈·기록 변경을 main에 커밋하고 push한다. 스킬은 쓰기 전에 begin, 쓴 뒤에 commit을 부른다.
//   순서와 거부 규칙: bin/lib/sync.mjs
import { run, args, usage } from './lib/report.mjs';
import { begin, commit } from './lib/sync.mjs';
import { withLock } from './lib/lock.mjs';

const USAGE = `사용법: wb sync begin [--files <파일> …]
       wb sync commit --files <파일> … --message <메시지>
  begin   쓰기 전에 부른다. HEAD가 main인지 확인하고 원격 변경을 받는다. --files를 주면 그 파일에 커밋 안 된 편집이 없어야 한다
          대상 파일이 아직 없으면(이슈 생성) --files 없이 부른다
  commit  쓴 뒤에 부른다. 지정한 파일만 lint → fetch → commit → push 한다. 메시지는 받은 그대로 쓴다
  같은 PC의 다른 sync가 git을 쓰는 중이면 끝날 때까지 기다린다(최대 WORKBENCH_SYNC_LOCK_TIMEOUT_MS, 기본 120초)
  WORKBENCH_SYNC=skip 이면 둘 다 아무것도 하지 않고 성공한다 (원격이 없는 복제본)
  WORKBENCH_SYNC=local 이면 fetch·push 없이 main 확인·대상 검사·lint·로컬 커밋만 한다 (커밋 단위를 남길 복제본)`;

run(async () => {
  const { values, positionals } = args({ files: { type: 'boolean' }, message: { type: 'string' } }, USAGE);
  const [step, ...rest] = positionals;
  if (rest.length && !values.files) throw usage('파일을 지정하려면 --files를 쓴다', USAGE);
  if (step === 'begin') {
    const r = withLock(() => begin({ files: rest }), { label: 'sync begin' });
    return { data: r, text: r.skipped ? '건너뜀: WORKBENCH_SYNC=skip' : r.local ? '준비됨: main (WORKBENCH_SYNC=local, 원격 확인 없음)' : `준비됨: main${r.pulled ? `, 원격 커밋 ${r.pulled}개를 받았다` : ', 원격과 같다'}` };
  }
  if (step === 'commit') {
    if (!rest.length) throw usage('commit에는 --files <파일> …이 필요하다', USAGE);
    if (!values.message?.trim()) throw usage('commit에는 --message가 필요하다', USAGE);
    const r = withLock(() => commit({ files: rest, message: values.message }), { label: 'sync commit' });
    if (r.skipped) return { data: r, text: '건너뜀: WORKBENCH_SYNC=skip' };
    if (r.local) return { data: r, text: r.committed ? `로컬 커밋: ${r.committed} (WORKBENCH_SYNC=local, push 안 함)` : '변경 없음: 커밋할 것이 없다' };
    if (!r.pushed) return { data: r, text: '변경 없음: 커밋할 것도 push할 것도 없다' };
    return {
      data: r,
      text: [`커밋·push: ${r.committed ?? '(새 커밋 없음, 밀린 커밋 push)'}${r.retried ? ' — 원격 변경 위에 다시 올려 push했다' : ''}`, '  참고: 로컬 보드(wb board)에는 바로, 다른 PC의 보드에는 다음 fetch 때 보인다'].join('\n'),
    };
  }
  throw usage(`단계는 begin 또는 commit이다: ${step ?? '(없음)'}`, USAGE);
}, USAGE);
