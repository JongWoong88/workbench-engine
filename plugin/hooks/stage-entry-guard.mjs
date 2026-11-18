#!/usr/bin/env node
// 단계 진입 가드(PC별 설정 stage-entry-guard, 기본 off).
//   이슈의 단계 스킬(workbench:groundwork·workbench:plan) 진입을 orchestrate로 한정하는 실험 장치다.
//   PreToolUse(matcher Skill)는 모델의 Skill 도구 호출을, UserPromptExpansion은 사용자가 직접 입력한 `/스킬` 명령을 받는다.
//   판정(앞 행에 걸리면 뒤 행은 보지 않는다):
//     G-1 workbench:orchestrate            → 이 세션의 진입 표시에 task_id(없으면 `*`)를 더하고 통과
//     G-2 단계 스킬이 아님                  → 통과(기록하지 않는다)
//     G-3 인자에 task_id가 없거나 보드에 없음 → 통과(이슈 없는 기록)
//     G-4 이슈 컬럼이 in-progress 이후      → 통과(구현 중·후 기록)
//     G-5 이 세션의 진입 표시에 task_id나 `*` → 통과
//     G-6 그 밖                            → 막고 orchestrate로 안내
//   진입 표시: <설정 폴더>/stage-entry/<세션>.json. SessionEnd 훅이 지우고, 24시간 넘은 파일은 판정할 때 지운다
//   측정 기록: <설정 폴더>/stage-entry/events.jsonl. 인자 원문은 남기지 않는다
//   off이거나 무엇이든 실패하면 아무것도 출력하지 않고 0으로 끝낸다(세션을 막지 않는다). 실패는 측정 기록에 error로 남긴다
//   Node 내장 모듈만 쓴다(설치물 규칙). plugin/cli/를 가져오지 않는다
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configDir, userConfig, dataRoot, taskIdKeys, safeName } from './lib/env.mjs';

export const ORCHESTRATE = 'workbench:orchestrate';
export const STAGE_SKILLS = ['workbench:groundwork', 'workbench:plan'];
export const STALE_MS = 24 * 60 * 60 * 1000;
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const guardDir = (dir = configDir()) => path.join(dir, 'stage-entry');
export const markFile = (sessionId, dir = configDir()) => path.join(guardDir(dir), `${safeName(sessionId)}.json`);
export const eventsFile = (dir = configDir()) => path.join(guardDir(dir), 'events.jsonl');

/** 훅 입력에서 경로·스킬 이름·인자를 꺼낸다. 처리할 이벤트가 아니면 null, 필수 필드가 없으면 missing: true */
export function readInput(input) {
  const event = input?.hook_event_name;
  if (event === 'PreToolUse') {
    const skill = input.tool_input?.skill;
    return typeof skill === 'string' ? { via: 'tool', event, skill, args: String(input.tool_input?.args ?? '') } : { via: 'tool', event, missing: true };
  }
  if (event === 'UserPromptExpansion') {
    const skill = input.command_name;
    return typeof skill === 'string' ? { via: 'slash', event, skill, args: String(input.command_args ?? '') } : { via: 'slash', event, missing: true };
  }
  return null;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 인자에서 projects.tsv 키로 시작하는 `{키}-{번호}` 중 처음 나온 것. 없으면 null */
export function findTaskId(text, keys) {
  if (!keys.length) return null;
  const m = new RegExp(`(?<![A-Za-z0-9])(?:${keys.map(escape).join('|')})-\\d+(?![A-Za-z0-9])`).exec(text);
  return m ? m[0] : null;
}

/** board.yml의 columns 순서. `- id: x`와 `- {id: x, …}` 둘 다 읽는다. YAML 라이브러리 없이 줄 단위로 읽는다 */
export function columnOrder(boardYml) {
  const ids = [];
  let inColumns = false;
  for (const line of boardYml.split(/\r?\n/)) {
    if (/^columns:\s*$/.test(line)) { inColumns = true; continue; }
    if (inColumns && /^\S/.test(line)) break;
    const m = inColumns && /^\s*-\s*\{?\s*id:\s*['"]?([a-z0-9-]+)/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** 이슈 파일 프론트매터의 column 값. 못 읽으면 null */
export function readColumn(taskText) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(taskText);
  const m = fm && /^column:\s*['"]?([A-Za-z0-9-]+)/m.exec(fm[1]);
  return m ? m[1] : null;
}

/**
 * 판정. 파일을 읽지 않는 순수 함수다.
 * @returns {{result:'mark'|'pass'|'deny', rule:string, mark?:string, error?:string}}
 */
export function judge({ skill, taskId, taskExists, column, columns, marks }) {
  if (skill === ORCHESTRATE) return { result: 'mark', rule: 'G-1', mark: taskId ?? '*' };
  if (!STAGE_SKILLS.includes(skill)) return { result: 'pass', rule: 'G-2' };
  if (!taskId || !taskExists) return { result: 'pass', rule: 'G-3' };
  const at = columns.indexOf(column);
  const from = columns.indexOf('in-progress');
  if (at < 0 || from < 0) return { result: 'pass', rule: 'G-4', error: 'unknown-column' };
  if (at >= from) return { result: 'pass', rule: 'G-4' };
  if (marks.includes(taskId) || marks.includes('*')) return { result: 'pass', rule: 'G-5' };
  return { result: 'deny', rule: 'G-6' };
}

/** 막을 때 보이는 사유. 모델(Skill 도구)과 사용자(직접 입력)에게 문구가 다르다 */
export function denyReason(via, taskId) {
  return via === 'tool'
    ? `이 PC는 단계 진입 실험 중이다(stage-entry-guard on). ${taskId}의 조사·제안·설계·계획 문서는 \`/workbench:orchestrate ${taskId} <요청 요지>\`로 진행한다. 사용자에게 다시 묻지 않고 바로 실행한다.`
    : `단계 진입 실험 중이다. \`/workbench:orchestrate ${taskId}\`로 진행한다. 끄려면 \`wb config set stage-entry-guard off\`.`;
}

/** 훅 출력. 막을 때만 쓴다 */
export function denyOutput(event, reason) {
  return event === 'PreToolUse'
    ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
    : { decision: 'block', reason };
}

/** 이 세션의 진입 표시. 파일이 없으면 빈 목록. 깨졌으면 예외(부르는 쪽이 통과로 처리한다) */
export function readMarks(sessionId, dir = configDir()) {
  const file = markFile(sessionId, dir);
  if (!fs.existsSync(file)) return [];
  let rec;
  try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('broken-mark'); }
  if (!Array.isArray(rec?.tasks)) throw new Error('broken-mark');
  return rec.tasks;
}

/** 진입 표시에 더한다. 임시 파일에 쓰고 이름을 바꾼다 */
export function addMark(sessionId, task, dir = configDir()) {
  fs.mkdirSync(guardDir(dir), { recursive: true });
  let tasks = [];
  try { tasks = readMarks(sessionId, dir); } catch { /* 깨진 표시는 새로 쓴다 */ }
  if (!tasks.includes(task)) tasks.push(task);
  const file = markFile(sessionId, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ sessionId: String(sessionId), tasks, updatedAt: new Date().toISOString() })}\n`);
  fs.renameSync(tmp, file);
}

/** 진입 표시를 지운다(SessionEnd) */
export function removeMarks(sessionId, dir = configDir()) {
  fs.rmSync(markFile(sessionId, dir), { force: true });
}

/** 수정 시각이 STALE_MS를 넘은 표시 파일을 지운다. events.jsonl은 대상이 아니다 */
export function sweepStale(dir = configDir(), now = Date.now()) {
  let names;
  try { names = fs.readdirSync(guardDir(dir)); } catch { return; }
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const file = path.join(guardDir(dir), n);
    try { if (now - fs.statSync(file).mtimeMs > STALE_MS) fs.rmSync(file, { force: true }); } catch { /* 다른 훅이 먼저 지웠다 */ }
  }
}

/** 측정 기록 한 줄. 실패하면 버린다 */
export function logEvent(event, dir = configDir()) {
  try {
    fs.mkdirSync(guardDir(dir), { recursive: true });
    fs.appendFileSync(eventsFile(dir), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  } catch { /* 기록을 못 해도 판정은 그대로다 */ }
}

/** 훅 한 번. 출력할 객체(막을 때) 또는 null */
export function run(input, { dir = configDir(), conf = userConfig(dir), boardFile = process.env.WORKBENCH_BOARD_FILE || path.join(PLUGIN_ROOT, 'board.yml') } = {}) {
  const req = readInput(input);
  if (!req) return null;
  const base = { session: input.session_id ?? null, via: req.via };
  if (req.missing || !input.session_id) {
    logEvent({ ...base, result: 'pass', error: 'missing-field' }, dir);
    return null;
  }
  if (req.skill !== ORCHESTRATE && !STAGE_SKILLS.includes(req.skill)) return null; // G-2: 기록하지 않는다

  let taskId = null;
  try {
    const data = dataRoot(conf);
    taskId = data ? findTaskId(req.args, taskIdKeys(path.join(data, 'projects.tsv'))) : null;
    sweepStale(dir);
    if (req.skill === ORCHESTRATE) {
      const v = judge({ skill: req.skill, taskId });
      addMark(input.session_id, v.mark, dir);
      logEvent({ ...base, skill: req.skill, task: taskId, result: v.result, rule: v.rule }, dir);
      return null;
    }
    const taskPath = data && taskId ? path.join(data, 'board', 'tasks', `${taskId}.md`) : null;
    const taskExists = Boolean(taskPath && fs.existsSync(taskPath));
    const v = judge({
      skill: req.skill,
      taskId,
      taskExists,
      column: taskExists ? readColumn(fs.readFileSync(taskPath, 'utf8')) : null,
      columns: taskExists ? columnOrder(fs.readFileSync(boardFile, 'utf8')) : [],
      marks: taskExists ? readMarks(input.session_id, dir) : [],
    });
    logEvent({ ...base, skill: req.skill, task: taskId, result: v.result, rule: v.rule, ...(v.error ? { error: v.error } : {}) }, dir);
    return v.result === 'deny' ? denyOutput(req.event, denyReason(req.via, taskId)) : null;
  } catch (e) {
    logEvent({ ...base, skill: req.skill, task: taskId, result: 'pass', error: e?.message === 'broken-mark' ? 'broken-mark' : 'exception' }, dir);
    return null;
  }
}

function main() {
  try {
    const dir = configDir();
    const conf = userConfig(dir);
    if (conf.stageEntryGuard !== true) return; // 꺼짐 빠른 경로: stdin도 읽지 않는다
    let input;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {
      logEvent({ result: 'pass', error: 'bad-input' }, dir);
      return;
    }
    const out = run(input, { dir, conf });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // 어떤 경우에도 세션을 막지 않는다
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
  process.exit(0);
}
