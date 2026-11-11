// 명령 실행과 거부 응답 규약.
//
// 모든 명령은 실패할 때 "무엇이 / 어디서 / 어떻게 고치는가 / 누가 고치는가 / 무엇으로 다시 확인하는가"를
// 함께 알린다. 에이전트가 거부 메시지만 읽고 다음 행동을 정할 수 있어야 하기 때문이다.
//
// 종료 코드
//   0  성공
//   1  거부 — 입력·파일 내용이 규칙에 맞지 않음. `수정`대로 고친 뒤 다시 실행한다
//   2  사용법 오류 — 인자가 틀림. 인자를 고쳐 다시 실행한다
//   3  환경 오류 — 의존성·git 등 실행 환경 문제. `수정`대로 환경을 갖춘다
//   70 내부 오류 — 스크립트 결함. 고치려 하지 말고 사용자에게 보고한다
import path from 'node:path';
import { parseArgs } from 'node:util';

export const EXIT = { OK: 0, REJECTED: 1, USAGE: 2, ENV: 3, INTERNAL: 70 };

// 누가 고치는가. 에이전트가 스스로 고쳐도 되는지 판단하는 근거다
export const OWNER = {
  agent: '에이전트가 바로 고친다',
  board: '보드 수정이다. 사용자가 지시한 작업 범위 안이면 고치고, 아니면 고치지 말고 사용자에게 보고한다',
  user: '사용자 판단이 필요하다. 고치지 말고 사용자에게 보고해 결정을 받는다',
};

export class Rejection extends Error {
  /**
   * @param {object} o
   * @param {string} o.code     규칙 코드 (예: TASK-NOT-FOUND)
   * @param {string} o.message  무엇이 문제인가
   * @param {string|string[]} o.fix 어떻게 고치는가 (구체적 행동)
   * @param {keyof OWNER} [o.owner] 누가 고치는가
   * @param {string} [o.file]   대상 파일 (workbench 기준 상대경로)
   * @param {number} [o.line]
   * @param {string} [o.rerun]  고친 뒤 확인할 명령
   * @param {number} [o.exit]
   */
  constructor({ code, message, fix, owner = 'agent', file, line, rerun, exit = EXIT.REJECTED }) {
    super(message);
    Object.assign(this, { code, fix: [].concat(fix), owner, file, line, rerun, exit });
  }
}

export const usage = (message, usageText) =>
  new Rejection({ code: 'USAGE', message, fix: ['인자를 아래 사용법에 맞게 고쳐 다시 실행한다', ...usageText.split('\n')], exit: EXIT.USAGE });

/** parseArgs 래퍼. 알 수 없는 옵션은 사용법 거부로 바꾼다 */
export function args(options, usageText, { positionals = true } = {}) {
  try {
    return parseArgs({ options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: positionals });
  } catch (e) {
    throw usage(e.message, usageText);
  }
}

// 명령은 `wb <명령>`으로 실행한다. 메시지 속 옛 표기 `node bin/<명령>.mjs`도 `wb <명령>`으로 바꿔 출력한다
const localize = (s) => s.replace(/\bnode bin\/([a-z][a-z-]*)\.mjs\b/g, 'wb $1');

/** 지금 실행 중인 명령 이름(wb가 argv[1]을 명령 파일 경로로 맞춘다) */
export const commandName = () => path.basename(process.argv[1] ?? '', '.mjs');

function rerunCommand() {
  const a = process.argv.slice(2);
  const q = (s) => (/[\s"'|&<>]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return ['wb', commandName(), ...a.filter((x) => x !== '--json')].map(q).join(' ') + '  (인자를 고친 뒤)';
}

export function formatRejection(r) {
  const lines = [`거부 [${r.code}] ${r.message}`];
  if (r.file) lines.push(`  대상: ${r.file}${r.line ? `:${r.line}` : ''}`);
  r.fix.forEach((f, i) => lines.push(`  ${i === 0 ? '수정' : '    '}: ${f}`));
  if (r.exit === EXIT.REJECTED || r.exit === EXIT.ENV) lines.push(`  누가: ${OWNER[r.owner]}`);
  if (r.rerun) lines.push(`  확인: ${r.rerun}`);
  return lines.join('\n');
}

/**
 * 명령 진입점. main이 돌려준 값을 출력한다.
 * - 객체: --json이면 {ok:true, ...}로, 아니면 `text` 필드(없으면 JSON)를 출력
 * - Rejection: --json이면 {ok:false, ...}를 stdout에, 아니면 사람이 읽는 형식을 stderr에 출력
 */
export async function run(main, usageText, { needsData = true } = {}) {
  const json = process.argv.includes('--json');
  const out = (s) => console.log(localize(s));
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    out(usageText);
    return;
  }
  try {
    // 문서 저장소를 읽고 쓰는 명령은 위치가 정해졌는지 먼저 확인한다(workbench.mjs가 이 모듈을 불러오므로 실행 시점에 부른다)
    if (needsData) {
      (await import('./workbench.mjs')).requireDataRoot();
      (await import('./shared-config.mjs')).requireKnownFormat();
    }
    const result = await main();
    if (result === undefined) return;
    if (json) out(JSON.stringify({ ok: true, ...result.data }, null, 2));
    else out(result.text ?? JSON.stringify(result.data, null, 2));
    process.exitCode = result.exit ?? EXIT.OK;
  } catch (e) {
    if (!(e instanceof Rejection)) {
      e = new Rejection({
        code: 'INTERNAL', message: `스크립트 내부 오류: ${e.stack || e}`,
        fix: '스크립트 결함일 수 있다. 우회하거나 스크립트를 고치지 말고, 실행한 명령과 이 출력을 사용자에게 보고한다',
        owner: 'user', exit: EXIT.INTERNAL,
      });
    }
    // 에이전트가 고칠 수 있는 거부에는 고친 뒤 다시 실행할 명령을 붙인다
    if (!e.rerun && e.owner === 'agent' && (e.exit === EXIT.REJECTED || e.exit === EXIT.USAGE)) e.rerun = rerunCommand();
    if (json) out(JSON.stringify({ ok: false, code: e.code, message: e.message, file: e.file, line: e.line, fix: e.fix, owner: e.owner, ownerText: OWNER[e.owner], rerun: e.rerun, exit: e.exit }, null, 2));
    else console.error(localize(formatRejection(e)));
    process.exitCode = e.exit;
  }
}
