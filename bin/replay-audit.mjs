#!/usr/bin/env node
// replay 실행이 격리를 지켰는지 감사한다. 위반이 한 건이라도 있으면 그 실행은 무효다(종료 코드 1).
import path from 'node:path';
import { run, args, usage, Rejection } from '../plugin/cli/lib/report.mjs';
import { read, exists } from '../plugin/cli/lib/workbench.mjs';
import { auditRun } from './lib/replay-audit.mjs';

const USAGE = `사용법: node bin/replay-audit.mjs --sandbox <사례 복제본 폴더> [--run <실행 기록.jsonl>]
  --sandbox  replay-sandbox.mjs가 만든 사례 폴더. 그 안 claude-config/projects의 대화 기록을 모두 검사한다
  --run      replay-run.mjs가 남긴 stream-json 기록. 생략하면 대화 기록만 검사한다`;

run(async () => {
  const { values } = args({ sandbox: { type: 'string' }, run: { type: 'string' } }, USAGE, { positionals: false });
  if (!values.sandbox) throw usage('--sandbox가 필요하다', USAGE);
  const info = path.join(values.sandbox, 'sandbox.json');
  if (!exists(info)) throw new Rejection({ code: 'REPLAY-NOT-SANDBOX', message: `복제본 폴더가 아니다: ${values.sandbox}`, fix: 'replay-sandbox.mjs가 만든 사례 폴더를 준다' });
  const { config } = JSON.parse(read(info));
  const r = auditRun({ runFile: values.run, configDir: config });
  if (!r.valid) {
    throw new Rejection({
      code: 'REPLAY-INVALID',
      message: `격리 위반 ${r.findings.length}건 — 이 실행은 무효다\n${r.findings.slice(0, 20).map((f) => `    [${f.rule}] ${path.basename(f.source)}:${f.line}${f.tool ? ` ${f.tool}` : ''} ${f.detail}`).join('\n')}`,
      fix: ['이 실행의 결과는 채점에 쓰지 않는다', '위반 경로를 보고 셸 허용 목록·deny 규칙을 고칠지, 컨테이너 격리로 올릴지 정한다 (설계 4장)'],
      owner: 'user',
    });
  }
  return { data: { valid: true, files: r.files.length }, text: `감사 통과: 기록 ${r.files.length}개에서 격리 위반 0건` };
}, USAGE, { needsData: false });
