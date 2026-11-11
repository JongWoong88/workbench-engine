#!/usr/bin/env node
// 다음 task_id를 발급한다. 발급만 하고 기록하지 않으므로, 보드에 이슈를 만들 때는 bin/new-task.mjs를 쓴다
// (발급과 기록을 한 번에 해서 번호를 예약한다).
//
// 1. projects.tsv에서 project의 key를 찾는다
// 2. 같은 key를 쓰는 모든 project의 저장소를 fetch한다 (원격이 없으면 건너뜀)
// 3. 아래에서 {key}-{번호}를 모아 최대값을 구한다
//    - projects.tsv의 모든 저장소: 로컬·원격 브랜치명, 전체 커밋 메시지
//    - 보드: .kanbn/tasks/*.md 와 보관된 .kanbn/archive/*.md 의 task_id
//    - records/<project>/<task_id>/ 폴더명
// 4. {key}-{최대값+1}을 stdout에 한 줄로 출력한다. 경고는 stderr로 나간다
import { run, args, usage } from './lib/report.mjs';
import { nextTaskId } from './lib/taskid.mjs';

const USAGE = `사용법: wb next-task-id <project> [--no-fetch] [--json]
  project     projects.tsv의 project 값 (예: app)
  --no-fetch  원격 fetch를 건너뛴다 (오프라인 확인용. 번호가 겹칠 수 있다)`;

run(async () => {
  const { values, positionals } = args({ 'no-fetch': { type: 'boolean' } }, USAGE);
  if (positionals.length !== 1) throw usage('project를 하나 지정해야 한다', USAGE);
  const r = nextTaskId(positionals[0], { fetch: !values['no-fetch'] });
  r.warnings.forEach((w) => console.error(w));
  if (r.warnings.some((w) => w.includes('fetch 실패'))) {
    console.error('  → 번호가 다른 사람의 것과 겹칠 수 있다. 사용자에게 fetch 실패를 알린다');
  }
  return { data: r, text: r.id };
}, USAGE);
