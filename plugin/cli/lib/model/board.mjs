// 보드 형식의 순수 파서. node: 모듈을 쓰지 않는다 — bin/과 보드 화면(브라우저 번들)가 함께 쓴다.
// 형식과 규칙의 정본: 형식 문서(references/workbench-format.md) "보드 (board/)"
import YAML from 'yaml';
import { ParseError } from './errors.mjs';

/** 컬럼 상태. waiting(대기) / active(진행) / closed(종료) */
export const STATES = ['waiting', 'active', 'closed'];
export const COLUMN_ID_RE = /^[a-z][a-z0-9-]*$/;

/** board.yml 객체의 형식 위반 목록. 비어 있으면 정상 */
export function boardProblems(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['최상위가 맵이 아니다'];
  const columns = Array.isArray(obj.columns) ? obj.columns : null;
  if (!columns || columns.length === 0) problems.push('`columns`가 비어 있거나 목록이 아니다');
  const ids = new Set();
  for (const [i, c] of (columns ?? []).entries()) {
    const at = `columns[${i}]`;
    if (!c || typeof c !== 'object') { problems.push(`${at}가 맵이 아니다`); continue; }
    if (typeof c.id !== 'string' || !COLUMN_ID_RE.test(c.id)) problems.push(`${at}.id '${c.id}'는 영문 소문자·숫자·하이픈이어야 한다`);
    else if (ids.has(c.id)) problems.push(`${at}.id '${c.id}'가 중복된다`);
    else ids.add(c.id);
    if (typeof c.label !== 'string' || !c.label.trim()) problems.push(`${at}.label이 비어 있다`);
    if (!STATES.includes(c.state)) problems.push(`${at}.state '${c.state}'는 ${STATES.join(' / ')} 중 하나여야 한다`);
  }
  for (const [i, v] of (Array.isArray(obj.views) ? obj.views : []).entries()) {
    const at = `views[${i}]`;
    if (!v || typeof v.id !== 'string' || typeof v.label !== 'string') { problems.push(`${at}에 id·label이 없다`); continue; }
    for (const id of [].concat(v.columns ?? [])) if (!ids.has(id)) problems.push(`${at}(${v.id})가 없는 컬럼 '${id}'를 가리킨다`);
  }
  if (obj.views !== undefined && !Array.isArray(obj.views)) problems.push('`views`가 목록이 아니다');
  return problems;
}

/** board.yml 텍스트 → 보드. 읽을 수 없거나 형식 위반이면 ParseError(code BOARD-CONFIG)를 던진다. 형식 위반은 problems에 담는다 */
export function parseBoardText(text) {
  let obj;
  try {
    obj = YAML.parse(text);
  } catch (e) {
    throw new ParseError({ code: 'BOARD-CONFIG', message: `board.yml을 YAML로 읽을 수 없다: ${e.message.split('\n')[0]}` });
  }
  const problems = boardProblems(obj);
  if (problems.length) throw new ParseError({ code: 'BOARD-CONFIG', message: `board.yml이 형식에 맞지 않는다 (${problems.length}건)`, problems });
  const columns = obj.columns.map(({ id, label, state, color }) => ({ id, label, state, color: color ?? null }));
  return {
    columns,
    views: (obj.views ?? []).map(({ id, label, columns: cs }) => ({ id, label, columns: [].concat(cs ?? []) })),
    description: obj.description ?? '',
    byId: new Map(columns.map((c) => [c.id, c])),
    byLabel: new Map(columns.map((c) => [c.label, c])),
  };
}

/**
 * 이슈 작성자. author가 없으면 history 첫 항목(생성 이력)의 author를 쓴다(호환 규칙 K-2 — author 필드가 생기기 전 이슈).
 * 파일은 고치지 않는다. 둘 다 없으면 null
 */
export function effectiveAuthor(data) {
  const v = data?.author;
  if (v !== undefined && v !== null && v !== '') return String(v);
  const first = Array.isArray(data?.history) ? data.history[0] : null;
  return first && first.author !== undefined && first.author !== null && first.author !== '' ? String(first.author) : null;
}

/** task 파일 → { data, body, bodyLine, error? }. 프론트매터를 읽지 못해도 던지지 않고 error를 채운다 */
export function parseTaskText(text) {
  const t = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  if (!m) return { data: {}, body: t, bodyLine: 1, error: '프론트매터가 없다' };
  const rest = t.slice(m[0].length);
  const lead = rest.startsWith('\n') ? 1 : 0;
  const result = { body: rest.slice(lead), bodyLine: m[0].split('\n').length + lead };
  try {
    const data = YAML.parse(m[1]) ?? {};
    if (typeof data !== 'object' || Array.isArray(data)) return { ...result, data: {}, error: '프론트매터가 맵이 아니다' };
    return { ...result, data };
  } catch (e) {
    return { ...result, data: {}, error: `프론트매터를 YAML로 읽을 수 없다: ${e.message.split('\n')[0]}` };
  }
}
