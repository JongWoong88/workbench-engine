// 보드 화면이 쓰는 모델. board.yml·이슈 파일·projects.tsv 텍스트로 조립한다(보드 API에서 읽은 그대로).
// 본문·워크플로 설명은 마크다운으로 두고 그리는 쪽에서 렌더링한다. 형식: references/workbench-format.md "보드 (board/)"
import { parseBoardText, parseTaskText, effectiveAuthor } from '../../plugin/cli/lib/model/board.mjs';
import { parseProjects } from '../../plugin/cli/lib/model/projects.mjs';
import { ParseError } from '../../plugin/cli/lib/model/errors.mjs';
import { resolveHref, hostUrls } from './links.mjs';

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const str = (v) => (v === null || v === undefined ? v : String(v));

/** projects.tsv → 링크 변환에 쓰는 대응표. remote 열이 없거나 항목 수가 repos와 다르면 ParseError */
export function loadProjects(text) {
  const projects = parseProjects(text);
  const bad = projects.rows.filter((r) => !r.hasRemoteColumn || r.remoteMismatch);
  if (bad.length) {
    throw new ParseError({ code: 'TSV-REMOTE', message: `projects.tsv의 remote 열이 repos와 맞지 않는다 (${bad.length}행)`, problems: bad.map((r) => `${r.line}행 ${r.project}`) });
  }
  return projects;
}

/** 산출물 항목. 제목과 파일 존재(missing)는 팝업을 열 때 채운다(recordTitle) */
function outputEntry(o, ctx) {
  const path = String(o.path ?? '');
  const entry = { kind: str(o.kind), path, desc: str(o.desc), title: basename(path.split('#')[0]), missing: null };
  const r = resolveHref(path, 'x', ctx);
  if (r.kind === 'record') return { ...entry, record: r.path, anchor: r.anchor, url: null, external: false };
  return { ...entry, record: null, url: r.kind === 'host' ? r.url : null, external: true, missing: r.kind !== 'host' };
}

/** 기록 문서의 제목: 프론트매터 title → 본문 첫 H1 → 파일명 */
export function recordTitle(text, path) {
  const { data, body } = parseTaskText(text);
  if (data.title) return String(data.title);
  const h1 = /^# (.+)$/m.exec(body);
  return h1 ? h1[1].trim() : basename(path);
}

/**
 * 보드 모델을 조립한다.
 * @param {{ boardText: string, projectsText: string, tasks: { path: string, text: string }[],
 *           ctx: { host: {type, web}|null, repo: string|null, commit: string } }} input
 * board.yml·projects.tsv 오류는 ParseError로 던진다(화면은 마지막 정상 모델을 유지한다).
 * 이슈 하나의 오류는 errors에 모으고 그 이슈만 뺀다.
 */
export function buildBoard({ boardText, projectsText, tasks, ctx: base }) {
  const board = parseBoardText(boardText);
  const projects = loadProjects(projectsText);
  const urls = hostUrls(base.host);
  const ctx = { urls, repo: base.repo ?? null, commit: base.commit, projects };
  const errors = [];
  const parsed = [];
  for (const { path, text } of tasks) {
    const t = parseTaskText(text);
    if (t.error) errors.push({ file: path, error: t.error });
    else if (!t.data.task_id) errors.push({ file: path, error: 'task_id가 없다' });
    else parsed.push({ path, data: t.data, body: t.body });
  }
  const children = new Map();
  for (const { data } of parsed) if (data.parent) children.set(data.parent, [...(children.get(data.parent) ?? []), data.task_id]);
  const out = parsed.map(({ path, data, body }) => {
    const { outputs, history, ...fields } = data;
    for (const k of ['created', 'started', 'completed']) if (fields[k] !== undefined) fields[k] = str(fields[k]);
    return {
      ...fields,
      author: effectiveAuthor(data), // author가 없으면 history 첫 항목(K-2)
      file: path,
      body,
      closed: board.byId.get(data.column)?.state === 'closed',
      children: (children.get(data.task_id) ?? []).sort(),
      outputs: (Array.isArray(outputs) ? outputs : []).filter((o) => o && typeof o === 'object').map((o) => outputEntry(o, ctx)),
      history: (Array.isArray(history) ? history : []).filter((h) => h && typeof h === 'object')
        .map((h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k, str(v)]))),
    };
  });
  return {
    commit: { sha: base.commit, short: base.commit.slice(0, 7) },
    board: { columns: board.columns, views: board.views, description: board.description },
    // 호스트 링크. 설정이 없으면 null이고 화면은 링크를 만들지 않는다
    host: { urls, repo: base.repo ?? null },
    projects: Object.fromEntries(projects.rows.map((r) => [r.project, {
      key: r.key,
      repos: r.repos.map((path, i) => ({ path, remote: r.remote[i], url: r.remote[i] && urls ? urls.repo(r.remote[i]) : null })),
    }])),
    ctx,
    tasks: out.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0)),
    errors,
  };
}
