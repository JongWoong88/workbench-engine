#!/usr/bin/env node
// 복제본에서 replay를 실행한다. 전용 CLAUDE_CONFIG_DIR, 사용자 설정 출처만(=전용 설정), MCP 없음, dontAsk,
// 복제본의 workbench 플러그인(--plugin-dir), 원격 없이 로컬 커밋만(WORKBENCH_SYNC=local).
// 실행 기록은 <사례 폴더>/runs/<시각>.jsonl에 남기고, 끝나면 감사한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, args, usage, Rejection, EXIT } from '../plugin/cli/lib/report.mjs';
import { read, exists } from '../plugin/cli/lib/workbench.mjs';
import { auditRun } from './lib/replay-audit.mjs';
import { runInvocation } from './lib/replay.mjs';

const USAGE = `사용법: node bin/replay-run.mjs --sandbox <사례 복제본 폴더> --prompt-file <프롬프트.md> [--model <모델>] [--timeout-min 60]
  프롬프트 파일 안의 {{INPUT}}은 사례 입력(input.md)으로 바뀐다`;

run(async () => {
  const { values } = args({ sandbox: { type: 'string' }, 'prompt-file': { type: 'string' }, model: { type: 'string' }, 'timeout-min': { type: 'string' } }, USAGE, { positionals: false });
  if (!values.sandbox || !values['prompt-file']) throw usage('--sandbox와 --prompt-file이 필요하다', USAGE);
  const caseDir = path.resolve(values.sandbox);
  const infoFile = path.join(caseDir, 'sandbox.json');
  if (!exists(infoFile)) throw new Rejection({ code: 'REPLAY-NOT-SANDBOX', message: `복제본 폴더가 아니다: ${caseDir}`, fix: 'replay-sandbox.mjs가 만든 사례 폴더를 준다' });
  const info = JSON.parse(read(infoFile));
  if (!exists(path.join(info.config, '.credentials.json'))) {
    throw new Rejection({
      code: 'REPLAY-NOT-LOGGED-IN', message: `전용 설정 폴더에 로그인 정보가 없다: ${info.config}`,
      fix: [`CLAUDE_CONFIG_DIR=${info.config} 로 claude를 대화형으로 한 번 실행하고 /login 한다`], owner: 'user', exit: EXIT.ENV,
    });
  }
  const prompt = read(path.resolve(values['prompt-file'])).replace('{{INPUT}}', read(path.join(caseDir, 'input.md')));
  const runs = path.join(caseDir, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const runFile = path.join(runs, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

  const { args: cli, env } = runInvocation(info, { model: values.model });
  const r = spawnSync(cli.join(' '), {
    cwd: info.cwd, input: prompt, encoding: 'utf8', shell: true, maxBuffer: 512 * 1024 * 1024,
    timeout: Number(values['timeout-min'] ?? 60) * 60 * 1000,
    env: { ...process.env, ...env },
  });
  fs.writeFileSync(runFile, r.stdout ?? '');
  if (r.status !== 0 && !(r.stdout ?? '').trim()) {
    throw new Rejection({ code: 'REPLAY-RUN-FAILED', message: `claude 실행 실패(종료 ${r.status}): ${(r.stderr ?? '').slice(0, 500)}`, fix: '전용 설정 로그인 상태와 claude 설치를 확인한다', owner: 'user', exit: EXIT.ENV });
  }
  const last = (r.stdout ?? '').trim().split('\n').reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((m) => m?.type === 'result');
  const audit = auditRun({ runFile, configDir: info.config });
  const text = [`실행 기록: ${runFile}`, `종료: ${r.status}${last ? `, 결과 ${last.subtype}, 턴 ${last.num_turns}, 비용 $${last.total_cost_usd ?? '?'}` : ''}`,
    audit.valid ? '감사 통과: 격리 위반 0건' : `감사 실패: 격리 위반 ${audit.findings.length}건 — 이 실행은 무효다 (자세히: node bin/replay-audit.mjs --sandbox ${caseDir} --run ${runFile})`].join('\n');
  return { data: { runFile, status: r.status, result: last ?? null, valid: audit.valid, findings: audit.findings }, text, exit: audit.valid ? EXIT.OK : EXIT.REJECTED };
}, USAGE);
