// workbench 규칙 검사. 각 규칙은 위반마다 finding을 낸다.
//   finding = { rule, severity: 'error'|'warn', file, line?, message, fix: string[], owner, related?: string[] }
//   file·related는 workbench 기준 상대경로다. --changed 등에서 대상 파일과 겹치는 finding만 보인다.
import fs from 'node:fs';
import path from 'node:path';
import {
  WB, RECORDS, TSV, TAGS, RECORD_FIELDS, TASK_ID_RE, locateRepoPath,
  rel, posix, read, exists, git, today, suggest, yamlScalar, parseFrontmatter, h1,
  loadProjects, listFiles,
} from './workbench.mjs';
import { BOARD_FILE, BOARD_FILE_LABEL, loadBoard, loadBoardTasks, parseTaskText } from './board.mjs';
import { anchorsOf, headingItemId } from './anchors.mjs';
import { SHARED_CONFIG_FILE, parseSharedConfig } from './shared-config.mjs';
import { effectiveAuthor } from './model/board.mjs';
import { Rejection } from './report.mjs';

/** LF를 강제하는 확장자 (.gitattributes와 EOL-CRLF 검사 대상) */
const EOL_EXTS = ['md', 'yml', 'mjs', 'js', 'html', 'css'];

const KIND_BY_PREFIX = [['discovery', '조사'], ['proposal', '제안'], ['policy', '정책'], ['decision', '결정'], ['design', '설계'], ['plan', '작업계획'], ['review', '검토'], ['verification', '검증'], ['qa', 'QA']];

/** 코드 블록·인라인 코드를 같은 길이의 공백으로 지운다 (줄 번호 유지) */
function stripCode(text) {
  return text
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}
const lineAt = (text, idx) => text.slice(0, idx).split('\n').length;

export function collectLinks(text) {
  const t = stripCode(text.replace(/\r\n/g, '\n'));
  const out = [];
  for (const m of t.matchAll(/!?\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push({ href: m[1], line: lineAt(t, m.index) });
  return out;
}

export function resolveHref(href, baseDir) {
  const clean = href.split('#')[0];
  if (!clean) return null;
  let decoded = clean;
  try { decoded = decodeURIComponent(clean); } catch { /* 그대로 */ }
  return path.resolve(baseDir, decoded);
}

/** 프론트매터에서 키가 처음 나오는 줄 (없으면 1) */
const lineOfKey = (text, key) => {
  const i = text.replace(/\r\n/g, '\n').split('\n').findIndex((l) => l.startsWith(`${key}:`));
  return i === -1 ? 1 : i + 1;
};
const fmText = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
const TASK_REQUIRED = ['task_id', 'title', 'project', 'type', 'column', 'author', 'created'];

/**
 * 오류 규칙의 도입 형식 버전(호환 규칙 K-3). 여기 없는 규칙은 형식 버전 1부터다.
 * 새 오류 규칙(또는 기존 규칙의 검사를 강화하는 변경)을 넣을 때는 반드시 FORMAT_VERSION(shared-config.mjs)을 올리고 그 값을 여기 적는다.
 * 그래야 엔진을 갱신해도 기존 문서 저장소의 lint가 갑자기 실패하지 않는다
 */
export const RULE_SINCE = {};

/** 문서 저장소 formatVersion보다 늦게 생긴 오류 규칙의 위반을 경고로 낮춘다 */
export function applySince(findings, formatVersion, since = RULE_SINCE) {
  return findings.map((f) => {
    const v = since[f.rule] ?? 1;
    if (f.severity !== 'error' || v <= formatVersion) return f;
    const note = '형식 버전 ' + v + '부터 오류다. 문서 저장소의 formatVersion이 ' + formatVersion + '이라 경고로 냈다. 고친 뒤 workbench.config.json의 formatVersion을 ' + v + '로 올리면 오류로 검사한다';
    return { ...f, severity: 'warn', since: v, fix: [...f.fix, note] };
  });
}

/**
 * @param {object} [opts]
 * @param {{rel: string, head: string|null, index: string|null}[]} [opts.staged]
 *   스테이징된 이슈 파일의 HEAD·인덱스 내용. lint --staged(pre-commit)만 넘긴다 — TASK-MOVE-UNRECORDED
 */
export function runRules({ staged = [] } = {}) {
  const findings = [];
  const add = (f) => findings.push({ severity: 'error', owner: 'agent', related: [], ...f, fix: [].concat(f.fix) });
  const projects = loadProjects();
  const boardRel = BOARD_FILE_LABEL;

  // ── 보드 설정 ──────────────────────────────────────────
  let board = null;
  if (!exists(BOARD_FILE)) {
    add({ rule: 'BOARD-CONFIG', file: boardRel, owner: 'user', message: `보드 설정(${boardRel})이 없다`, fix: ['엔진 설치가 깨졌다. workbench 플러그인을 다시 설치하고, 계속되면 사용자에게 알린다'] });
  } else {
    try {
      board = loadBoard();
    } catch (e) {
      if (!(e instanceof Rejection)) throw e;
      add({ rule: 'BOARD-CONFIG', file: boardRel, owner: 'board', message: e.message, fix: e.fix });
    }
  }
  if (board) {
    for (const c of board.columns) {
      if (!board.description.includes(c.label)) add({ rule: 'BOARD-CONFIG', severity: 'warn', file: boardRel, owner: 'board', message: `컬럼 '${c.label}'이 description의 워크플로 설명에 없다`, fix: ['board.yml description에 이 컬럼의 의미를 한 줄 추가한다'] });
    }
  }

  // ── 보드: 이슈 ─────────────────────────────────────────
  const tasks = board ? loadBoardTasks(board) : [];
  const byId = new Map();
  for (const t of tasks) if (t.data.task_id) byId.set(t.data.task_id, [...(byId.get(t.data.task_id) ?? []), t]);
  for (const t of tasks) {
    const text = read(t.file);
    const line = (k) => lineOfKey(text, k);
    if (t.error) {
      add({ rule: 'TASK-FORMAT', file: t.rel, line: 1, owner: 'board', message: `이슈 파일을 읽을 수 없다: ${t.error}`, fix: ['프론트매터(--- 사이의 YAML)를 고친다. 형식: 형식 문서(references/workbench-format.md) "이슈 파일"'] });
      continue;
    }
    const d = t.data;
    for (const k of TASK_REQUIRED) {
      // author가 없어도 history 첫 항목에 작성자가 있으면 그 값을 쓴다(K-2)
      if (k === 'author' ? effectiveAuthor(d) === null : d[k] === undefined || d[k] === null || d[k] === '') {
        add({ rule: 'TASK-FIELD', file: t.rel, line: 1, owner: 'board', message: `${k}가 없다`,
          fix: [k === 'task_id' ? `\`wb next-task-id ${d.project ?? '<project>'}\`로 번호를 발급해 \`task_id: <번호>\`를 적고 파일 이름도 같게 한다` : `프론트매터에 \`${k}: <값>\`을 적는다`] });
      }
    }
    if (d.task_id && !TASK_ID_RE.test(d.task_id)) {
      add({ rule: 'TASK-ID-FORMAT', file: t.rel, line: line('task_id'), owner: 'board', message: `task_id '${d.task_id}'가 {키}-{번호} 형식이 아니다`, fix: ['projects.tsv의 키와 발급된 번호로 고친다 (예: APP-460)'] });
    }
    if (d.task_id && t.name !== d.task_id) {
      add({ rule: 'TASK-FILE', file: t.rel, line: line('task_id'), owner: 'board', message: `파일 이름(${t.name}.md)이 task_id ${d.task_id}와 다르다`, fix: [`파일 이름을 board/tasks/${d.task_id}.md로 바꾼다 (git mv)`] });
    }
    if (d.project && !projects.byProject.has(d.project)) {
      const near = suggest(d.project, projects.names);
      add({ rule: 'TASK-PROJECT', file: t.rel, line: line('project'), owner: 'board', message: `project '${d.project}'가 projects.tsv에 없다`,
        fix: [near ? `오타라면 \`project: ${near}\`로 고친다` : `projects.tsv의 값으로 고친다: ${projects.names.join(', ')}`, '이 이슈의 records 폴더 이름도 같은 값이어야 한다'] });
    } else if (d.project && d.task_id && TASK_ID_RE.test(d.task_id)) {
      const key = projects.byProject.get(d.project).key;
      if (!d.task_id.startsWith(`${key}-`)) {
        add({ rule: 'TASK-KEY', file: t.rel, line: line('task_id'), owner: 'user', message: `task_id ${d.task_id}의 키가 project '${d.project}'의 키 ${key}와 다르다`,
          fix: ['project가 틀렸는지 task_id가 틀렸는지 사용자에게 확인한다. 한 번 부여한 task_id는 바꾸지 않는 것이 원칙이다'] });
      }
    }
    if (d.type && !TAGS.includes(d.type)) {
      const near = suggest(String(d.type), TAGS);
      add({ rule: 'TASK-TYPE', file: t.rel, line: line('type'), owner: 'board', message: `type '${d.type}'는 허용값이 아니다`, fix: [`${near ? `'${near}'를 뜻했다면 그것으로 고친다. ` : ''}허용값: ${TAGS.join(', ')}`] });
    }
    if (d.column && !board.byId.has(d.column)) {
      const byLabel = board.byLabel.get(d.column);
      add({ rule: 'TASK-COLUMN', file: t.rel, line: line('column'), owner: 'board', message: `column '${d.column}'이 board.yml에 없다`, fix: [byLabel ? `컬럼은 이름이 아니라 id로 쓴다: \`column: ${byLabel.id}\`` : `있는 컬럼 id: ${board.columns.map((c) => c.id).join(', ')}`] });
    }
    if (d.parent) {
      const parent = byId.get(d.parent)?.[0];
      if (d.parent === d.task_id) add({ rule: 'TASK-PARENT', file: t.rel, line: line('parent'), owner: 'board', message: 'parent가 자기 자신이다', fix: ['parent 줄을 지우거나 상위 이슈의 task_id로 고친다'] });
      else if (!parent) add({ rule: 'TASK-PARENT', file: t.rel, line: line('parent'), owner: 'board', message: `parent ${d.parent} 이슈가 보드에 없다`, fix: ['상위 이슈의 task_id를 확인해 고친다. 모르면 사용자에게 묻는다'] });
      else if (parent.data.parent) add({ rule: 'TASK-PARENT', file: t.rel, line: line('parent'), owner: 'board', related: [parent.rel], message: `상위 이슈 ${d.parent}도 parent(${parent.data.parent})가 있다. parent는 한 단계만 허용한다`, fix: ['가장 위 이슈를 parent로 두거나, 중간 이슈의 parent를 지운다. 어느 쪽인지 사용자에게 확인한다'] });
    }
    const seenOut = new Set();
    for (const o of [].concat(d.outputs ?? [])) {
      if (!o?.kind || !o?.path) { add({ rule: 'TASK-OUTPUT', file: t.rel, line: line('outputs'), owner: 'board', message: 'outputs 항목에 kind나 path가 없다', fix: ['`wb link-output`로 다시 단다. 형식: {kind, path, desc}'] }); continue; }
      if (seenOut.has(o.path)) add({ rule: 'TASK-OUTPUT', file: t.rel, line: line('outputs'), owner: 'agent', message: `outputs에 같은 경로가 두 번 있다: ${o.path}`, fix: ['한 항목을 지운다'] });
      seenOut.add(o.path);
      const abs = path.resolve(WB, o.path.split('#')[0]);
      const inside = abs.startsWith(WB + path.sep);
      // 저장소 산출물은 논리 경로다. 이 PC의 실제 폴더에서 확인하고, 저장소가 없으면 건너뛴다
      const loc = inside ? null : locateRepoPath(abs, projects.allRepos);
      const checkable = inside || (loc && exists(path.join(loc.dir, '.git')));
      if (checkable && !exists(inside ? abs : loc.abs)) add({ rule: 'TASK-OUTPUT', file: t.rel, line: line('outputs'), owner: 'agent', message: `산출물 경로에 파일이 없다: ${o.path}`, fix: ['경로는 workbench 루트 기준이다(records/… 또는 ../{워크스페이스}/{저장소}/…). 옮겨진 문서면 경로를 고치고, 지워진 문서면 항목을 지운다'] });
    }
    if (d.archived !== undefined && d.archived !== true) add({ rule: 'TASK-ARCHIVED', file: t.rel, line: line('archived'), owner: 'board', message: `archived는 true만 쓴다('${d.archived}')`, fix: ['보관하지 않으면 archived 줄을 지운다. 보관·꺼내기는 `wb archive-task <task_id> [--restore]`로 한다'] });
    else if (t.archived && !t.closed) add({ rule: 'TASK-ARCHIVED', file: t.rel, line: line('archived'), owner: 'board', message: '보관된 이슈가 종료 컬럼에 있지 않다', fix: [`다시 진행하는 이슈라면 꺼낸다: wb archive-task ${d.task_id} --restore`, '종료한 이슈라면 종료 컬럼으로 옮긴다. 어느 쪽인지 모르면 사용자에게 묻는다'] });
    const unquoted = [...fmText(text).matchAll(/^(\s*)(created|started|completed|date): (?!['"])(\S.*)$/gm)];
    if (unquoted.length) add({ rule: 'TASK-DATE', file: t.rel, line: 1, owner: 'agent', message: `따옴표 없는 시각 ${unquoted.length}건: ${unquoted.map((m) => m[2]).join(', ')}`, fix: ["시각을 작은따옴표로 감싼다 (예: created: '2026-10-29T00:00:00.000Z'). YAML 1.1 파서가 날짜 객체로 읽지 않게 하기 위함이다"] });
    if (t.closed && !d.completed) add({ rule: 'TASK-DATE', severity: 'warn', file: t.rel, line: line('column'), owner: 'board', message: '종료 컬럼인데 completed가 없다 (Web IDE에서 column만 고친 것으로 보인다)', fix: ["`completed: '<종료 시각>'`을 적거나, 다음부터는 `wb move-task`로 옮긴다"] });
  }

  // task_id 중복
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const info = group.map((t) => {
      const hasRec = t.data.project && exists(path.join(RECORDS, t.data.project, id));
      return `${t.rel}(생성 ${String(t.data.created ?? '?').slice(0, 10)}${hasRec ? ', records 폴더 있음' : ''})`;
    });
    for (const t of group) {
      add({ rule: 'TASK-ID-DUP', file: t.rel, line: lineOfKey(read(t.file), 'task_id'), owner: 'user', related: group.map((g) => g.rel),
        message: `task_id ${id}가 이슈 ${group.length}개에 중복되어 있다: ${info.join(', ')}`,
        fix: ['어느 이슈를 재발급할지 사용자에게 확인한다. records 폴더·브랜치·커밋이 이미 그 번호를 쓰는 쪽을 유지한다', `재발급할 이슈는 \`wb next-task-id <project>\`로 받은 번호로 바꾼다`] });
    }
  }

  // ── projects.tsv ───────────────────────────────────────
  const tsvRel = rel(TSV);
  // TSV-REMOTE의 옛 이름은 TSV-GITLAB이다(alias)
  for (const r of projects.rows) {
    if (!r.hasRemoteColumn) add({ rule: 'TSV-REMOTE', alias: 'TSV-GITLAB', file: tsvRel, line: r.line, owner: 'user', message: `project '${r.project}' 행에 remote 열(넷째 열)이 없다`, fix: ['넷째 열에 repos와 같은 순서의 호스트 저장소 경로를 쉼표로 적는다(`git remote get-url origin`에서 호스트와 .git을 뗀 값). 저장소가 없거나 쓰지 않으면 -'] });
    else if (r.remoteMismatch) add({ rule: 'TSV-REMOTE', alias: 'TSV-GITLAB', file: tsvRel, line: r.line, owner: 'user', message: `project '${r.project}'의 remote 항목 수가 repos(${r.repos.length}개)와 다르다`, fix: ['repos와 같은 순서·개수로 적는다. 저장소마다 `git remote get-url origin`의 경로를 쓰고, 없으면 그 자리에 -'] });
  }

  // ── 공유 설정 ───────────────────────────────────────────
  const sharedFile = path.join(WB, SHARED_CONFIG_FILE);
  if (exists(sharedFile)) {
    for (const p of parseSharedConfig(read(sharedFile)).problems) {
      add({ rule: 'CONFIG-SHARED', severity: p.severity, file: SHARED_CONFIG_FILE, owner: 'user', message: p.message, fix: [p.severity === 'error' ? `${SHARED_CONFIG_FILE}의 ${p.key || '내용'}을 고친다. 키는 모두 생략할 수 있다(생략하면 기본값)` : '오타면 고치고, 더 새 엔진이 쓰는 키면 플러그인을 갱신한다'] });
    }
  }

  // ── 기록 ───────────────────────────────────────────────
  const taskById = new Map([...byId].map(([id, g]) => [id, g[0]]));
  const label = (t) => board?.byId.get(t.data.column)?.label ?? t.data.column;
  const projectDirs = exists(RECORDS) ? fs.readdirSync(RECORDS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  for (const p of projectDirs) {
    const pdir = path.join(RECORDS, p);
    const files = listFiles(pdir);
    if (!projects.byProject.has(p)) {
      const near = suggest(p, projects.names);
      add({ rule: 'REC-PROJECT', file: `records/${p}/`, owner: 'user', related: files.map(rel), message: `records 폴더 '${p}'가 projects.tsv의 project 값이 아니다`, fix: [near ? `'${near}' 폴더로 옮겨야 하는지 사용자에게 확인한다` : 'projects.tsv에 project를 추가할지, 다른 폴더로 옮길지 사용자에게 확인한다'] });
    }
    for (const e of fs.readdirSync(pdir, { withFileTypes: true })) {
      if (!e.isDirectory() || !TASK_ID_RE.test(e.name)) continue;
      const id = e.name;
      const idir = path.join(pdir, id);
      const ifiles = listFiles(idir).map(rel);
      const task = taskById.get(id);
      if (!task) {
        add({ rule: 'REC-ISSUE', file: `records/${p}/${id}/`, owner: 'user', related: ifiles, message: `이슈 폴더 ${id}에 해당하는 이슈가 보드에 없다`, fix: ['폴더 이름이 오타면 바른 task_id로 폴더를 옮긴다', '이슈가 정말 없으면 이슈를 새로 만들지 말고 사용자에게 알린다 (이슈 없는 기록은 records/{project}/ 바로 아래에 둔다)'] });
        continue;
      }
      if (task.data.project !== p) {
        const tsvOk = projects.byProject.has(task.data.project);
        add({ rule: 'REC-ISSUE-PROJECT', file: `records/${p}/${id}/`, owner: tsvOk ? 'user' : 'board', related: [...ifiles, task.rel],
          message: `이슈 ${id}의 project는 '${task.data.project}'인데 기록은 records/${p}/에 있다`,
          fix: [tsvOk ? `기록 폴더를 records/${task.data.project}/${id}/로 옮길지, 이슈의 project를 '${p}'로 고칠지 사용자에게 확인한다` : `이슈의 project '${task.data.project}'가 projects.tsv에 없다. 이슈를 \`project: ${p}\`로 고치면 해소된다 (${task.rel})`] });
      }
      // 산출물 누락: 이슈 폴더 바로 아래의 .md (qa/, review-*/ 같은 하위 폴더는 통합 문서만 단다)
      const linked = new Set([].concat(task.data.outputs ?? []).filter((o) => o?.path).map((o) => path.resolve(WB, o.path.split('#')[0])));
      for (const f of fs.readdirSync(idir).filter((f) => f.endsWith('.md'))) {
        const abs = path.join(idir, f);
        if (linked.has(abs)) continue;
        const kind = KIND_BY_PREFIX.find(([pre]) => f.toLowerCase().startsWith(pre))?.[1] ?? '<구분>';
        add({ rule: 'REC-UNLINKED', file: rel(abs), owner: 'agent', message: `이슈 ${id}의 outputs에 이 기록이 없다`,
          fix: [`wb link-output --task ${id} --kind ${kind} --path ${rel(abs)} --desc "<한 줄 설명>"`, '설명은 문서를 읽고 한 줄로 쓴다. 구분이 맞지 않으면 바꾼다'] });
      }
      // 동결
      if (task.closed) {
        add({ rule: 'REC-FROZEN', severity: 'warn', file: `records/${p}/${id}/`, owner: 'user', related: ifiles, frozen: { task, idir },
          message: `이슈 ${id}는 '${label(task)}' 상태라 기록이 동결되었다`,
          fix: ['링크 경로 수정처럼 판단이 바뀌지 않는 수정이면 그대로 둔다', '판단을 바꾸는 수정이면 되돌리고, 새 이슈의 기록에서 이전 기록을 링크한다. 사용자에게 확인한다'] });
      }
    }

    // 프론트매터
    for (const abs of files.filter((f) => f.endsWith('.md'))) {
      const r = rel(abs);
      const seg = r.split('/');
      const issueId = seg.length >= 4 && TASK_ID_RE.test(seg[2]) ? seg[2] : null;
      const text = read(abs);
      const fm = parseFrontmatter(text);
      const required = issueId ? [...RECORD_FIELDS.slice(0, 2), 'task_id', ...RECORD_FIELDS.slice(2)] : RECORD_FIELDS;
      const missing = required.filter((k) => fm.data[k] === undefined || fm.data[k] === null || fm.data[k] === '');
      if (!fm.has || missing.length) {
        const block = suggestFrontmatter({ abs, project: p, issueId, fm, projects });
        add({ rule: fm.has ? 'REC-FM-FIELD' : 'REC-FM-MISSING', file: r, line: 1,
          message: fm.has ? `기록 프론트매터에 ${missing.join(', ')}가 없다` : '기록 프론트매터가 없다',
          fix: [
            fm.has ? `프론트매터에 다음 줄을 추가한다:\n${block.missingLines(missing)}` : `파일 맨 앞에 다음 프론트매터를 붙인다:\n${block.full}`,
            'repos는 근거로 삼은 저장소만 남긴다. base는 작성 시점의 브랜치@커밋을 알면 그 값을, 모르면 unknown으로 둔다',
          ] });
      }
      if (fm.has && fm.data.lifecycle && fm.data.lifecycle !== 'record') {
        add({ rule: 'REC-LIFECYCLE', file: r, line: fm.lines.lifecycle, message: `lifecycle이 '${fm.data.lifecycle}'다. workbench 기록은 record다`, fix: ['`lifecycle: record`로 고친다. 상시(living) 문서라면 workbench가 아니라 저장소 문서 루트에 있어야 한다 — 사용자에게 확인한다'] });
      }
      if (issueId && fm.data.task_id && fm.data.task_id !== issueId) {
        add({ rule: 'REC-TASKID', file: r, line: fm.lines.task_id, message: `task_id '${fm.data.task_id}'가 폴더 이름 ${issueId}와 다르다`, fix: [`폴더가 맞으면 \`task_id: ${issueId}\`로 고치고, task_id가 맞으면 파일을 records/{project}/${fm.data.task_id}/로 옮긴다`] });
      }
    }
  }

  // ── 링크 ───────────────────────────────────────────────
  const linkFiles = [
    ...tasks.map((t) => [t.file, path.dirname(t.file)]),
    ...listFiles(RECORDS).filter((f) => f.endsWith('.md')).map((f) => [f, path.dirname(f)]),
  ];
  // 앵커: workbench 안 마크다운을 가리키는 `#…`가 대상 문서에 있는지, ID 항목을 ID 앵커로 가리키는지
  const anchorCache = new Map();
  const anchorsAt = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(read(file)));
    return anchorCache.get(file);
  };
  const checkAnchor = (r, line, href, target) => {
    const hashAt = href.indexOf('#');
    if (hashAt < 0 || !target.endsWith('.md') || !target.startsWith(WB + path.sep) || !fs.statSync(target).isFile()) return;
    let anchor = href.slice(hashAt + 1);
    try { anchor = decodeURIComponent(anchor); } catch { /* 그대로 */ }
    if (!anchor) return;
    const { ids, headings } = anchorsAt(target);
    const where = target === path.join(WB, r) ? '이 문서' : rel(target);
    if (!ids.has(anchor)) {
      const near = [...ids].filter((id) => id.toLowerCase() === anchor.toLowerCase() || id.startsWith(`${anchor.toLowerCase()}-`)).slice(0, 3);
      add({ rule: 'LINK-ANCHOR', file: r, line, message: `링크 앵커 '#${anchor}'가 ${where}에 없다: ${href}`,
        fix: [
          ...near.map((id) => `'#${id}'를 가리키려던 것이면 그 값으로 고친다`),
          'ID가 있는 항목이면 대상 문서의 그 항목에 <a id="ID"></a>를 두고 #ID로 링크한다',
          '제목을 가리키면 제목 문구가 바뀌었는지 확인해 새 slug로 고친다',
        ] });
      return;
    }
    const h = headings.get(anchor);
    const id = h && (h.explicit[0] ?? headingItemId(h.text));
    if (!id || id === anchor) return;
    add({ rule: 'LINK-ANCHOR-ID', severity: 'warn', file: r, line, message: `ID 항목(${id})을 제목 slug '#${anchor}'로 가리킨다. 제목 문구가 바뀌면 링크가 깨진다`,
      fix: h.explicit.length
        ? [`'#${h.explicit[0]}'로 링크한다`]
        : [`대상 제목(${rel(target)}:${h.line})에 <a id="${id}"></a>를 넣고 '#${id}'로 링크한다`] });
  };

  for (const [abs, base] of linkFiles) {
    const r = rel(abs);
    const text = read(abs);
    const shas = baseShas(parseFrontmatter(text).data);
    for (const { href, line } of collectLinks(text)) {
      if (/^(https?|mailto|vscode|workspace):/i.test(href)) continue;
      if (href.startsWith('#')) { checkAnchor(r, line, href, abs); continue; }
      if (/^file:/i.test(href) || /^[A-Za-z]:[\\/]/.test(href) || href.startsWith('/')) {
        add({ rule: 'LINK-ABS', file: r, line, message: `절대경로 링크 '${href}'는 PC마다 경로가 달라 깨진다`, fix: ['이 파일 기준 상대경로로 바꾼다 (형식 문서(references/workbench-format.md) "링크 규칙")'] });
        continue;
      }
      if (!/[/.#]/.test(href)) {
        add({ rule: 'LINK-PROSE', severity: 'warn', file: r, line, message: `'](${href})'가 링크로 렌더링된다. 본문 표기([버튼](설명) 등)가 의도치 않게 링크가 된 것으로 보인다`, fix: ['대괄호를 이스케이프하거나(\\[확인\\]) 괄호 앞에 공백을 넣는다([확인] (설명))'] });
        continue;
      }
      const target = resolveHref(href, base);
      if (!target) continue;
      if (exists(target)) { checkAnchor(r, line, href, target); continue; }
      const inside = target.startsWith(WB + path.sep);
      const hints = [];
      const sameName = inside ? listFiles(RECORDS).filter((f) => path.basename(f) === path.basename(target)) : [];
      if (sameName.length === 1) hints.push(`같은 이름의 파일이 ${rel(sameName[0])}에 있다. 옮겨진 것이면 그 경로로 고친다 (이 파일 기준: ${posix(path.relative(base, sameName[0]))})`);
      if (inside) {
        // 기록은 특정 시점의 문서다. 그 파일의 이력 중 어느 커밋에라도 대상이 있었으면 깨진 링크가 아니라 지워진 대상이다.
        // 마지막 커밋만 보면 대상을 지운 뒤 기록을 조금만 고쳐도(체크리스트 등) 오류가 된다
        const targetRel = posix(path.relative(WB, target));
        const history = git(['log', '--format=%H', '--', r]).stdout.split('\n').filter(Boolean);
        const seenAt = history.find((c) => git(['cat-file', '-e', `${c}:${targetRel}`]).ok);
        if (seenAt) {
          add({ rule: 'LINK-REMOVED', severity: 'warn', file: r, line, message: `링크 대상이 지금은 없다(이 파일의 커밋 ${seenAt.slice(0, 7)}에는 있었다): ${href}`, fix: ['기록이면 그대로 둔다(작성 시점을 가리킨다). 상시 문서·이슈 본문이면 옮겨진 경로로 고치거나 링크를 지운다'] });
          continue;
        }
        add({ rule: 'LINK-BROKEN', file: r, line, message: `링크 대상이 없다: ${href}`, fix: [...hints, hints.length ? '' : '대상 파일이 옮겨졌거나 이름이 바뀌었는지 확인해 경로를 고친다. 지워진 문서라면 링크를 지운다'].filter(Boolean) });
      } else {
        // 저장소가 이 PC에 없으면 확인할 수 없다
        // 링크는 논리 경로다. 이 PC의 실제 폴더로 바꿔 확인한다
        const loc = locateRepoPath(target, projects.allRepos);
        if (!loc || !exists(path.join(loc.dir, '.git'))) continue;
        if (exists(loc.abs)) { checkAnchor(r, line, href, loc.abs); continue; }
        const repoRoot = loc.dir;
        const repoName = loc.name;
        const wsDir = loc.logical.split('/').slice(0, -1).join('/');
        // 기록의 링크는 base 시점 코드를 가리킨다. base 커밋에 파일이 있었으면 정상이다
        const sha = shas[repoName];
        const inRepo = loc.inRepo;
        if (sha && git(['cat-file', '-e', `${sha}:${inRepo}`], repoRoot).ok) continue;
        add({ rule: 'LINK-EXTERNAL', severity: 'warn', file: r, line, message: `workbench 밖 링크 대상이 ${sha ? `base 커밋(${repoName}@${sha})에도 지금 체크아웃에도` : '지금 체크아웃에'} 없다: ${href}`,
          fix: [
            sha ? '경로가 틀렸거나 파일 이름이 바뀌었다. 저장소에서 파일을 찾아 경로를 고친다' : `base가 없어 지금 체크아웃 기준으로만 확인했다. ${wsDir}/${repoName}가 다른 브랜치이거나 파일이 옮겨졌는지 확인한다`,
            '워크스페이스 루트에서 projects.tsv의 논리 경로({워크스페이스}/{저장소})를 거치는 경로인지 확인한다',
          ] });
      }
    }
  }

  // ── 줄바꿈 ─────────────────────────────────────────────
  const ga = exists(path.join(WB, '.gitattributes')) ? read(path.join(WB, '.gitattributes')) : '';
  for (const ext of EOL_EXTS) {
    if (!new RegExp(`^\\*\\.${ext}\\s+text\\s+eol=lf`, 'm').test(ga)) {
      add({ rule: 'EOL-CONFIG', severity: 'warn', file: '.gitattributes', message: `.gitattributes에 \`*.${ext} text eol=lf\`가 없다. Windows에서 CRLF로 커밋될 수 있다`, fix: [`.gitattributes에 \`*.${ext} text eol=lf\`를 추가한다`] });
    }
  }
  // 문서 저장소의 파일만 본다. 엔진 파일(site/ 등)은 문서 저장소에 없다
  const eolFiles = [RECORDS, path.join(WB, 'board')].flatMap(listFiles)
    .filter((f) => EOL_EXTS.includes(path.extname(f).slice(1)));
  for (const abs of eolFiles) {
    if (read(abs).includes('\r\n')) add({ rule: 'EOL-CRLF', severity: 'warn', file: rel(abs), message: '줄바꿈이 CRLF다', fix: ['LF로 저장한다'] });
  }

  // ── 손으로 바꾼 컬럼 (커밋 전, HEAD와 인덱스 비교) ──────────
  // Web IDE·에디터에서 column만 고치면 started·completed·history가 빠진다. 허용하되 경고하고 move-task를 안내한다
  for (const s of staged) {
    if (!s.head || !s.index) continue; // 새 이슈·삭제는 이동이 아니다
    const before = parseTaskText(s.head).data;
    const after = parseTaskText(s.index).data;
    if (!before.column || !after.column || before.column === after.column) continue;
    const recorded = [].concat(after.history ?? []).some((h) => h?.type === 'moved' && h.from === before.column && h.to === after.column);
    if (!recorded) {
      add({
        rule: 'TASK-MOVE-UNRECORDED', severity: 'warn', file: s.rel, line: lineOfKey(s.index, 'column'), owner: 'board',
        message: `column이 ${before.column} → ${after.column}로 바뀌었는데 그 이동이 history에 없다 (손으로 고친 이동)`,
        fix: [`column을 되돌리고 \`wb move-task ${after.task_id ?? '<task_id>'} ${after.column}\`로 옮긴다. 그래야 started·completed·history가 기록된다`],
      });
    }
  }

  // 호환 규칙 K-3: 문서 저장소의 형식 버전보다 나중에 생긴 오류 규칙은 경고로 낸다
  return applySince(findings, parseSharedConfig(exists(sharedFile) ? read(sharedFile) : '{}').config.formatVersion);
}

/** 기록 프론트매터 base → {저장소 이름: 커밋}. `main@abc` (repos가 하나) 또는 `{web: main@abc, …}` */
function baseShas(data) {
  const base = typeof data.base === 'string' ? data.base : '';
  const repos = [].concat(data.repos ?? []);
  const out = {};
  const pairs = base.startsWith('{') ? [...base.matchAll(/([\w.-]+(?:\([^)]*\))?)\s*:\s*[^@,}]+@([0-9a-f]{6,40})/g)].map((m) => [m[1].replace(/\(.*\)$/, ''), m[2]]) : [];
  for (const [n, sha] of pairs) out[n] ??= sha;
  const single = /@([0-9a-f]{6,40})\s*$/.exec(base);
  if (!pairs.length && single && repos.length === 1) out[repos[0]] = single[1];
  return out;
}

/** 프론트매터 제안값. 알 수 있는 값은 채우고 나머지는 자리표시자로 둔다 */
function suggestFrontmatter({ abs, project, issueId, fm, projects }) {
  const repos = projects.byProject.get(project)?.repos ?? [];
  const lastCommit = git(['log', '-1', '--format=%as', '--', abs]).stdout.trim();
  const values = {
    title: yamlScalar(fm.data.title || h1(fm.body) || path.basename(abs, '.md')),
    lifecycle: 'record',
    task_id: issueId,
    repos: repos.length === 1 ? `[${repos[0].split('/').pop()}]` : `[<근거 저장소${repos.length ? `: ${repos.map((r) => r.split('/').pop()).join(', ')} 중` : ''}>]`,
    base: 'unknown',
    updated: lastCommit || today(),
  };
  const order = ['title', 'lifecycle', 'task_id', 'repos', 'base', 'updated'].filter((k) => k !== 'task_id' || issueId);
  const ind = (s) => s.split('\n').map((l) => `          ${l}`).join('\n');
  return {
    full: ind(['---', ...order.map((k) => `${k}: ${values[k]}`), '---'].join('\n')),
    missingLines: (missing) => ind(order.filter((k) => missing.includes(k)).map((k) => `${k}: ${values[k]}`).join('\n')),
  };
}

/** --all에서 동결 위반 후보: 종료 이후 커밋이 있는 이슈 기록만 남긴다 */
export function frozenSinceClose(f) {
  const since = f.frozen.task.data.completed;
  if (!since) return null;
  const log = git(['log', `--since=${since}`, '--format=%h %as %s', '--', f.frozen.idir]).stdout.trim();
  return log ? log.split('\n') : null;
}
