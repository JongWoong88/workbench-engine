// workbench 보드 화면. 같은 출처의 보드 API(wb board)로 문서 저장소를 읽어 보드를 조립하고, 기록을 브라우저에서 렌더링한다.
// 의존(창·보드 API·렌더러)은 주입받는다 — 시험은 jsdom으로 한다. 화면은 호스트 API와 토큰을 모른다(X-1)
import { buildBoard, recordTitle } from './board-model.mjs';
import { ParseError } from '../../plugin/cli/lib/model/errors.mjs';
import { prompts, moveOptions, promptActions } from './prompts.mjs';

// 주소 해시가 열린 화면의 정본이다.
//   #{id}                     이슈 팝업
//   #{id}/{n}                 n번째 산출물(기록)
//   #{id}/{n|r}?r={경로}&a={앵커}  기록 안에서 따라간 다른 기록(r), 그 안의 위치(a). n 대신 r이면 본문에서 연 기록
const HASH = /^#([A-Z][A-Z0-9]*-\d+)(?:\/(\d+|r))?(?:\?(.*))?$/;

export function parseHash(hash) {
  const m = HASH.exec(hash);
  if (!m) return null;
  const q = new URLSearchParams(m[3] ?? '');
  return { id: m[1], output: m[2] === undefined ? null : m[2] === 'r' ? 'r' : Number(m[2]), record: q.get('r'), anchor: q.get('a') };
}

export function hashOf({ id, output = null, record = null, anchor = null }) {
  let h = `#${id}`;
  if (output !== null) h += `/${output}`;
  const q = new URLSearchParams();
  if (record) q.set('r', record);
  if (anchor) q.set('a', anchor);
  return q.size ? `${h}?${q}` : h;
}

/**
 * @param {{ window: Window, data: object, render: Function, config: object, loadVendor?: (name: string) => Promise<any>, copyText?: (text: string) => Promise<void> }} deps
 */
export function createApp({ window: w, data: api, render, config, loadVendor = async () => null, copyText = defaultCopy(w) }) {
  const doc = w.document;
  const $ = (id) => doc.getElementById(id);
  const state = { data: null, lastCheck: null, failed: false, deletedId: null, viewer: null, staleViewer: false, popupKey: null, fresh: false, banner: null, objectUrls: [], prompt: null };

  function el(tag, attrs = {}, ...children) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
    return e;
  }
  const time = (iso) => new Date(iso).toLocaleString('ko-KR', { hour12: false });
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('ko-KR') : '—');

  // ── 거르기: URL 쿼리가 정본이다 (링크로 공유할 수 있게) ──
  function readFilters() {
    const q = new URLSearchParams(w.location.search);
    return {
      view: q.get('view') || '', project: q.get('project') || '', type: q.get('type') || '', q: q.get('q') || '', archived: q.get('archived') === '1',
      authors: [...new Set(q.getAll('author').filter(Boolean))],
    };
  }

  function writeFilters() {
    const f = $('wb-filters');
    const q = new URLSearchParams();
    for (const k of ['view', 'project', 'type', 'q']) if (f.elements[k].value) q.set(k, f.elements[k].value.trim());
    // 작성자는 같은 이름의 체크박스 여럿이라 elements[k].value로 읽을 수 없다. 고른 값마다 author를 반복한다
    for (const box of $('wb-f-author-options').querySelectorAll('input[name="author"]:checked')) q.append('author', box.value);
    if (f.elements.archived.checked) q.set('archived', '1');
    const search = q.toString();
    w.history.replaceState(null, '', `${w.location.pathname}${search ? `?${search}` : ''}${w.location.hash}`);
    renderBoard();
  }

  function fillSelect(select, options, value) {
    select.replaceChildren(...options.map(([v, label]) => el('option', { value: v, selected: v === value }, label)));
  }

  function setupFilters() {
    const { board, tasks, projects } = state.data;
    const f = readFilters();
    fillSelect($('wb-f-view'), [['', '전체 컬럼'], ...board.views.map((v) => [v.id, v.label])], f.view);
    const used = [...new Set(tasks.map((t) => t.project))].sort();
    fillSelect($('wb-f-project'), [['', '전체'], ...Object.keys(projects).filter((p) => used.includes(p)).map((p) => [p, p])], f.project);
    fillSelect($('wb-f-type'), [['', '전체'], ...[...new Set(tasks.map((t) => t.type))].sort().map((t) => [t, t])], f.type);
    $('wb-f-q').value = f.q;
    $('wb-f-archived').checked = f.archived;
    fillAuthors(tasks, f.authors);
  }

  /** 작성자 체크박스 목록. 보드의 모든 작성자(보관 포함)와 URL에만 있는 이름. 갱신으로 다시 만들어도 포커스를 지킨다(펼침은 목록 밖이라 그대로다) */
  function fillAuthors(tasks, selected) {
    const box = $('wb-f-author-options');
    const focused = box.contains(doc.activeElement) ? doc.activeElement.value : null;
    const names = [...new Set([...tasks.map((t) => authorOf(t)).filter(Boolean), ...selected])].sort((a, b) => a.localeCompare(b, 'ko'));
    box.replaceChildren(...names.map((n) => el('label', {}, el('input', { type: 'checkbox', name: 'author', value: n, checked: selected.includes(n) }), ` ${n}`)));
    if (focused !== null) [...box.querySelectorAll('input')].find((i) => i.value === focused)?.focus();
  }

  const authorOf = (t) => (t.author === undefined || t.author === null ? '' : String(t.author));

  function setAuthorList(open, { focusButton = false } = {}) {
    $('wb-f-author-list').hidden = !open;
    $('wb-f-author').setAttribute('aria-expanded', String(open));
    if (focusButton) $('wb-f-author').focus();
  }

  function visibleTasks() {
    const f = readFilters();
    const q = f.q.toLowerCase();
    return state.data.tasks.filter((t) => (!f.project || t.project === f.project) && (!f.type || t.type === f.type)
      && (!q || t.task_id.toLowerCase().includes(q) || String(t.title ?? '').toLowerCase().includes(q)) && (f.archived || !t.archived)
      && (!f.authors.length || f.authors.includes(authorOf(t))));
  }

  // ── 렌더링: 본문 마크다운 → 정화된 DOM ──
  const routeFor = (taskId) => ({
    record: (path, anchor) => {
      const t = taskById(taskId);
      const n = t ? t.outputs.findIndex((o) => o.record === path) : -1;
      return n >= 0 ? hashOf({ id: taskId, output: n, anchor }) : hashOf({ id: taskId, output: 'r', record: path, anchor });
    },
    task: (id) => hashOf({ id }),
  });
  /** 문서 저장소 파일의 호스트 파일 보기 주소. 호스트 설정이 없으면 null */
  const fileUrl = (path) => (state.data.host.urls && state.data.host.repo ? state.data.host.urls.blob(state.data.host.repo, state.data.commit.sha, path) : null);
  // 이슈 밖(워크플로 설명)의 기록 링크는 호스트 파일 보기로 연다
  const outsideRoute = {
    record: (path) => fileUrl(path) ?? '#',
    task: (id) => hashOf({ id }),
  };

  function markdown(md, srcRel, route, frontmatter = false, commit = null) {
    const box = el('div', { class: 'md' });
    const ctx = commit ? { ...state.data.ctx, commit } : state.data.ctx;
    const r = render(md, { srcRel, ctx, route, frontmatter });
    box.append(r.fragment);
    return box;
  }

  // ── 뱃지: 카드와 팝업이 같이 쓴다. 유형은 색으로, project는 색 없이 모양으로 구분한다 ──
  const projectBadge = (p) => el('span', { class: 'badge project', title: 'project' }, p);
  const typeBadge = (type) => el('span', { class: `badge type type-${type}`, title: '유형' }, type);
  function columnBadge(id) {
    const c = state.data.board.columns.find((x) => x.id === id);
    const label = c?.label ?? id;
    // 뱃지에는 글자만 둔다(컬럼 label 앞의 이모지를 뗀다). 전체 label은 title로 보인다
    const text = label.replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, '') || label;
    return el('span', { class: 'badge stage', style: c?.color ? `--accent:${c.color}` : null, title: `컬럼 ${label}` }, text);
  }

  // ── 보드 ──
  function card(t, col) {
    return el('li', {},
      el('button', { type: 'button', class: `card${t.closed ? ' closed' : ''}${t.archived ? ' archived' : ''}`, style: col.color ? `--accent:${col.color}` : null, 'data-id': t.task_id, onclick: () => openTask(t.task_id) },
        el('span', { class: 'id' }, t.task_id),
        el('span', { class: 'title' }, t.title ?? '(제목 없음)'),
        el('span', { class: 'meta' },
          projectBadge(t.project),
          typeBadge(t.type),
          t.archived ? el('span', { class: 'chip' }, '보관') : null,
          t.parent ? el('span', { class: 'chip', title: '상위 이슈' }, `↳ ${t.parent}`) : null,
          t.children.length ? el('span', { class: 'chip', title: '하위 이슈' }, `하위 ${t.children.length}`) : null,
          t.outputs.length ? el('span', { class: 'chip', title: '산출물' }, `산출물 ${t.outputs.length}`) : null)));
  }

  function renderBoard() {
    const { board } = state.data;
    const f = readFilters();
    const view = board.views.find((v) => v.id === f.view);
    const columns = view ? view.columns.map((id) => board.columns.find((c) => c.id === id)).filter(Boolean) : board.columns;
    const tasks = visibleTasks();
    const hidden = state.data.tasks.filter((t) => t.archived).length;
    const scroll = $('wb-board').scrollLeft;
    $('wb-board').replaceChildren(...columns.map((col) => {
      const inCol = tasks.filter((t) => t.column === col.id).sort((a, b) => String(b.started ?? b.created).localeCompare(String(a.started ?? a.created)));
      return el('section', { class: 'column', style: col.color ? `--accent:${col.color}` : null, 'aria-label': col.label },
        el('h2', {}, el('span', {}, col.label), el('span', { class: 'count' }, String(inCol.length))),
        el('ol', {}, inCol.map((t) => card(t, col))));
    }));
    $('wb-board').scrollLeft = scroll;
    $('wb-f-author').textContent = f.authors.length ? `작성자 ${f.authors.length}` : '작성자 전체';
    $('wb-f-archived').parentElement.title = f.archived ? '' : `보관된 이슈 ${hidden}개를 숨겼다`;
  }

  function renderBanner() {
    const errors = state.data?.errors ?? [];
    const parts = [];
    if (state.banner) parts.push(el('div', {}, ...[].concat(state.banner)));
    if (errors.length) parts.push(el('div', {}, `형식 오류로 보드에서 뺀 이슈 ${errors.length}건: ${errors.map((e) => `${e.file} (${e.error})`).join(', ')}`));
    $('wb-errors').hidden = parts.length === 0;
    $('wb-errors').replaceChildren(...parts);
  }

  function renderStatus() {
    const d = state.data;
    if (!d) { $('wb-status').replaceChildren(); return; }
    $('wb-status').replaceChildren(
      `기준 커밋 ${d.commit.short} · 이슈 ${d.tasks.length}개`,
      state.fetchedAt ? ` · 마지막 fetch ${time(state.fetchedAt)}` : '',
      state.fetchError ? el('span', { class: 'stale' }, ` · fetch 실패: ${state.fetchError}`) : '',
      state.lastCheck ? ` · 마지막 확인 ${time(state.lastCheck)}` : '',
      state.failed ? el('span', { class: 'stale' }, ' · 갱신 실패 — 마지막으로 받은 내용을 보여 준다') : '');
  }

  function renderHelp() {
    $('wb-help').replaceChildren(markdown(state.data.board.description, 'board/board.yml', outsideRoute));
  }

  // ── 팝업 (design-site.md "팝업") ──
  const taskById = (id) => state.data?.tasks.find((t) => t.task_id === id);
  const columnOf = (t) => state.data.board.columns.find((c) => c.id === t.column);
  const openTask = (id, output = null) => { w.location.hash = hashOf({ id, output }); };

  function closeTask() {
    state.prompt = null;
    w.history.pushState(null, '', `${w.location.pathname}${w.location.search}`);
    renderPopup();
  }

  function taskLink(id) {
    const t = taskById(id);
    return el('button', { type: 'button', class: 'link-button', onclick: () => openTask(id) }, t ? `${id} ${t.title}` : `${id} (보드에 없음)`);
  }

  function repoLinks(t) {
    return (state.data.projects[t.project]?.repos ?? []).filter((r) => r.url).flatMap((r) => [
      el('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.path), ' (',
      el('a', { href: state.data.host.urls.tree(r.remote, `${t.type}/${t.task_id}`), target: '_blank', rel: 'noopener noreferrer' }, `브랜치 ${t.type}/${t.task_id}`), ') ',
    ]);
  }

  function outputItem(t, o, i) {
    const label = el('span', { class: 'kind' }, o.kind);
    if (o.missing) return el('li', {}, label, el('span', { class: 'missing', title: o.path }, `${o.title} (파일 없음)`));
    const open = o.external
      ? el('a', { href: o.url, target: '_blank', rel: 'noopener noreferrer', title: o.path }, `${o.title} ↗`)
      : el('button', { type: 'button', class: 'link-button', title: o.path, onclick: () => openTask(t.task_id, i) }, o.title);
    return el('li', {}, label, open);
  }

  function detailView(t) {
    const body = el('div', {});
    body.append(el('div', { class: 'task-badges' }, columnBadge(t.column), projectBadge(t.project), typeBadge(t.type),
      t.archived ? el('span', { class: 'chip' }, '보관') : null));
    body.append(promptTools(t));
    const parent = t.parent ? taskById(t.parent) : null;
    body.append(el('dl', { class: 'task-meta' },
      ...(t.parent ? [el('dt', {}, '상위 이슈'), el('dd', {}, taskLink(t.parent), parent ? [' ', columnBadge(parent.column)] : null)] : []),
      el('dt', {}, '작성'), el('dd', {}, authorOf(t) || '—'),
      el('dt', {}, '담당'), el('dd', {}, t.assigned ?? '—'),
      el('dt', {}, '생성 · 시작 · 완료'), el('dd', {}, `${fmtDate(t.created)} · ${fmtDate(t.started)} · ${fmtDate(t.completed)}`),
      ...(repoLinks(t).length ? [el('dt', {}, '저장소'), el('dd', {}, repoLinks(t))] : []),
      el('dt', {}, '파일'), el('dd', {}, fileUrl(t.file) ? el('a', { href: fileUrl(t.file), target: '_blank', rel: 'noopener noreferrer' }, t.file) : t.file)));
    // 산출물을 본문보다 먼저 둔다. 이슈를 여는 목적이 대개 기록을 찾는 것이기 때문이다
    body.append(el('section', { class: 'task-section' }, el('h3', {}, `산출물 ${t.outputs.length}`),
      t.outputs.length ? el('ul', { class: 'outputs' }, t.outputs.map((o, i) => outputItem(t, o, i))) : el('p', { class: 'empty' }, '없음')));
    if (t.body.trim()) body.append(el('section', { class: 'task-section' }, el('h3', {}, '본문'), markdown(t.body, t.file, routeFor(t.task_id))));
    // 하위 이슈는 머리의 "상위 이슈" 줄로 충분하다. 연결은 상위 이슈에만 둔다
    if (t.children.length) {
      body.append(el('section', { class: 'task-section' }, el('h3', {}, `연결 — 하위 이슈 ${t.children.length}`),
        el('table', { class: 'children' },
          el('thead', {}, el('tr', {}, el('th', {}, '이슈'), el('th', {}, '제목'), el('th', {}, '상태'))),
          el('tbody', {}, t.children.map((id) => {
            const c = taskById(id);
            return el('tr', {},
              el('td', {}, el('button', { type: 'button', class: 'link-button', onclick: () => openTask(id) }, id)),
              el('td', {}, c ? c.title ?? '(제목 없음)' : '(보드에 없음)'),
              el('td', {}, c ? columnBadge(c.column) : '—'));
          })))));
    }
    if (t.history.length) {
      const label = (id) => state.data.board.columns.find((c) => c.id === id)?.label ?? id;
      body.append(el('details', { class: 'task-section history' }, el('summary', {}, `History ${t.history.length}`),
        el('ol', {}, t.history.map((h) => el('li', {}, `${time(h.date)} ${h.author ?? ''} — `,
          { created: `생성 (${label(h.column)})`, archived: '보관', restored: '꺼냄' }[h.type] ?? `${label(h.from)} → ${label(h.to)}`)))));
    }
    // 산출물 제목·존재는 팝업을 열 때 채운다(보드 조립 때 파일마다 요청하지 않기 위해서다)
    fillOutputTitles(t);
    return body;
  }

  // ── 스킬 프롬프트 복사 ──
  // 사이트는 문자열만 클립보드에 넣는다. 보드를 바꾸는 것은 붙여넣어 실행한 스킬이다(읽기 전용 유지)

  /** 도구 막대 상태(고른 컬럼, 대체 입력란 문자열). 같은 이슈를 다시 그려도(주기 갱신·제목 채움·뷰어 왕복) 유지한다 */
  function promptUi(id) {
    if (state.prompt?.taskId !== id) state.prompt = { taskId: id, moveTo: '', fallback: null };
    return state.prompt;
  }

  function promptTools(t) {
    const ui = promptUi(t.task_id);
    const { board } = state.data;
    const acts = promptActions(t, board, taskById);
    const options = moveOptions(board, t);
    if (ui.moveTo && !options.some((c) => c.id === ui.moveTo)) Object.assign(ui, { moveTo: '', fallback: null });
    const fallback = el('div', { class: 'prompt-fallback' });
    const failed = (text) => { ui.fallback = text; showFallback(fallback, text, true); };
    const copied = () => { ui.fallback = null; fallback.replaceChildren(); };
    const copyButton = (label, text) => el('button', { type: 'button', title: text, onclick: (e) => copyPrompt(text, e.currentTarget, failed, copied) }, label);
    const items = [];
    if (acts.move) {
      const move = el('button', {
        type: 'button', disabled: !ui.moveTo, title: ui.moveTo ? prompts.move(t.task_id, ui.moveTo) : null,
        onclick: (e) => copyPrompt(prompts.move(t.task_id, ui.moveTo), e.currentTarget, failed, copied),
      }, '이동 복사');
      const select = el('select', {
        'aria-label': '옮길 컬럼',
        onchange: (e) => {
          ui.moveTo = e.target.value;
          move.disabled = !ui.moveTo;
          move.title = ui.moveTo ? prompts.move(t.task_id, ui.moveTo) : '';
          copied(); // 옛 프롬프트를 담은 대체 입력란을 남기지 않는다
        },
      }, el('option', { value: '' }, '옮길 컬럼'), options.map((c) => el('option', { value: c.id, selected: c.id === ui.moveTo }, c.label ?? c.id)));
      items.push(el('span', { class: 'prompt-move' }, select, move));
    }
    if (acts.drop) {
      items.push(copyButton('폐기 복사', prompts.drop(t.task_id)));
      if (acts.openChildren) items.push(el('span', { class: 'prompt-note' }, `끝나지 않은 하위 이슈 ${acts.openChildren}개 — 스킬이 그대로 폐기할지 묻는다`));
    }
    if (acts.archive) items.push(copyButton('보관 복사', prompts.archive(t.task_id)));
    if (acts.restore) items.push(copyButton('꺼내기 복사', prompts.restore(t.task_id)));
    if (ui.fallback) showFallback(fallback, ui.fallback, false);
    return el('div', { class: 'prompt-tools' }, el('div', { class: 'prompt-bar', role: 'group', 'aria-label': '스킬 프롬프트 복사' }, items), fallback);
  }

  /** 클립보드에 쓴다. 성공하면 버튼 글자를 잠시 "복사됨"으로, 실패하면 손으로 복사할 입력란을 연다 */
  async function copyPrompt(text, button, onFail, onDone) {
    try {
      await copyText(text);
    } catch {
      onFail(text);
      return;
    }
    onDone();
    button.dataset.label ??= button.textContent;
    button.textContent = '복사됨';
    const live = button.closest('dialog')?.querySelector('[aria-live]');
    if (live) live.textContent = '클립보드에 복사했다';
    w.setTimeout(() => { button.textContent = button.dataset.label; }, config.copiedMs ?? 2000);
  }

  function showFallback(box, text, select) {
    const area = el('textarea', { class: 'prompt-copy', readonly: true, rows: String(Math.min(8, text.split('\n').length)), 'aria-label': '복사할 프롬프트' });
    area.value = text;
    box.replaceChildren(el('p', { class: 'notice' }, '클립보드에 쓰지 못했다. 선택된 문자열을 Ctrl+C로 복사한다.'), area);
    if (select) {
      area.focus();
      area.select();
    }
  }

  // 이슈 생성 프롬프트 팝업. 주소 해시를 바꾸지 않고, 입력은 페이지를 새로 고치기 전까지 입력란에 남는다(브라우저 저장소에 두지 않는다)
  function closeNewDialog() {
    $('wb-new-fallback').replaceChildren();
    dialogClose($('wb-new-dialog'));
  }

  function bindNewDialog() {
    const dialog = $('wb-new-dialog');
    const text = $('wb-new-text');
    const copy = $('wb-new-copy');
    const fallback = $('wb-new-fallback');
    $('wb-new-open').addEventListener('click', () => { dialogOpen(dialog); text.focus(); });
    $('wb-new-close').addEventListener('click', closeNewDialog);
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeNewDialog(); }); // Esc
    dialog.addEventListener('click', (e) => { if (e.target === dialog) closeNewDialog(); }); // 바깥 클릭
    text.addEventListener('input', () => {
      copy.disabled = !prompts.create(text.value);
      fallback.replaceChildren();
    });
    copy.addEventListener('click', () => {
      const p = prompts.create(text.value);
      if (p) copyPrompt(p, copy, (s) => showFallback(fallback, s, true), () => fallback.replaceChildren());
    });
  }

  async function fillOutputTitles(t) {
    const pending = t.outputs.filter((o) => o.record && o.missing === null);
    if (!pending.length) return;
    try {
      const texts = await api.readPaths(pending.map((o) => o.record), state.data.commit.sha);
      for (const o of pending) {
        const text = texts[o.record];
        o.missing = text === null || text === undefined;
        if (!o.missing) o.title = recordTitle(text, o.record);
      }
      if (parseHash(w.location.hash)?.id === t.task_id) renderPopup();
    } catch { /* 제목은 파일명으로 둔다 */ }
  }

  function dialogOpen(d) { if (!d.open) (d.showModal ? d.showModal() : d.setAttribute('open', '')); }
  function dialogClose(d) { if (d.open) (d.close ? d.close() : d.removeAttribute('open')); }

  /** 지금 해시가 가리키는 기록: { task, path, title, anchor, n } 또는 null */
  function viewerTarget(h, t) {
    if (!t || h.output === null) return null;
    if (h.record) return { path: h.record, title: h.record.split('/').at(-1), anchor: h.anchor, n: h.output };
    const o = t.outputs[h.output];
    if (!o || !o.record) return null;
    return { path: o.record, title: o.title, anchor: h.anchor ?? (o.anchor || null), n: h.output, output: o };
  }

  function renderPopup() {
    const dialog = $('wb-task-dialog');
    const h = parseHash(w.location.hash);
    if (!h || !state.data) { dialogClose(dialog); state.popupKey = null; state.prompt = null; return; }
    closeNewDialog(); // 뒤로 가기 등으로 이슈 팝업이 열리면 생성 팝업은 닫는다(입력은 남는다)
    const t = taskById(h.id);
    const body = $('wb-task-body');
    const actions = [];
    body.className = 'dialog-body';
    const target = viewerTarget(h, t);
    if (!t) {
      $('wb-task-title').textContent = h.id;
      body.replaceChildren(el('p', { class: 'notice' }, state.deletedId === h.id ? `${h.id} 이슈는 삭제되었다.` : `${h.id} 이슈가 보드에 없다. 지워졌거나 번호가 틀렸다.`));
      state.viewer = null;
    } else if (target) {
      $('wb-task-title').textContent = `${t.task_id} · ${target.output ? `${target.output.kind}: ` : ''}${target.title}`;
      if (state.staleViewer) actions.push(el('button', { type: 'button', title: '새 커밋에서 이 기록이 바뀌었다', onclick: () => { state.staleViewer = false; state.viewer = null; renderPopup(); } }, '새 버전 불러오기'));
      actions.push(
        el('button', { type: 'button', onclick: () => openTask(t.task_id) }, '목록으로'),
        fileUrl(target.path) ? el('a', { class: 'button', href: fileUrl(target.path), target: '_blank', rel: 'noopener noreferrer' }, '원격에서 열기') : null);
      body.className = 'dialog-body viewer';
      showRecord(t, target, body);
    } else {
      $('wb-task-title').textContent = `${t.task_id} ${t.title}`;
      // 같은 이슈를 다시 그릴 때(주기 갱신)만 스크롤을 유지한다. 다른 이슈로 옮기면 맨 위부터 보인다
      const scroll = state.popupKey === t.task_id ? body.scrollTop : 0;
      body.replaceChildren(detailView(t));
      body.scrollTop = scroll;
      state.viewer = null;
      state.staleViewer = false;
    }
    $('wb-task-actions').replaceChildren(...actions);
    state.popupKey = target ? `${t.task_id}:${target.path}` : h.id;
    dialogOpen(dialog);
  }

  /** 기록을 받아 렌더링한다. 같은 기록을 다시 그릴 때는 받지 않고 앵커만 옮긴다(읽던 위치 유지) */
  async function showRecord(t, target, body) {
    const key = `${state.data.commit.sha}:${target.path}`;
    if (state.viewer?.key === key || (state.viewer?.path === target.path && state.staleViewer)) {
      if (target.anchor) scrollToAnchor(body, target.anchor);
      return;
    }
    state.viewer = { key, path: target.path, text: null };
    body.replaceChildren(el('p', { class: 'empty' }, '기록을 읽는 중…'));
    let text;
    let recordCommit;
    try {
      // 기록은 특정 시점의 문서다. 그 안의 workbench 파일 링크는 기록이 마지막으로 바뀐 커밋으로 연다(지워진 파일도 열린다)
      [text, recordCommit] = await Promise.all([
        api.readFile(target.path, state.data.commit.sha),
        api.lastCommit(target.path, state.data.commit.sha).catch(() => null),
      ]);
    } catch (e) {
      body.replaceChildren(el('p', { class: 'notice' }, `기록을 읽지 못했다: ${e.message}`));
      return;
    }
    if (state.viewer?.key !== key) return; // 그사이 다른 화면으로 옮겼다
    if (text === null) {
      if (target.output) target.output.missing = true;
      body.replaceChildren(el('p', { class: 'notice' }, `${target.path} 파일이 없다.`));
      return;
    }
    state.viewer.text = text;
    const box = markdown(text, target.path, routeFor(t.task_id), true, recordCommit);
    box.classList.add('record');
    for (const u of state.objectUrls.splice(0)) w.URL.revokeObjectURL?.(u);
    body.replaceChildren(box);
    const title = recordTitle(text, target.path);
    if (target.output) target.output.title = title;
    $('wb-task-title').textContent = `${t.task_id} · ${target.output ? `${target.output.kind}: ` : ''}${title}`;
    if (target.anchor) scrollToAnchor(body, target.anchor);
    await enhance(box);
  }

  /** 이미지(보드 API로 받기), mermaid, 코드 강조 */
  async function enhance(box) {
    for (const img of box.querySelectorAll('img[data-wb-src]')) {
      api.readBinary(img.getAttribute('data-wb-src'), state.data.commit.sha).then((blob) => {
        if (!blob) { img.alt = `${img.alt} (파일 없음)`; return; }
        const url = w.URL.createObjectURL(blob);
        state.objectUrls.push(url);
        img.src = url;
      }).catch(() => {});
    }
    const diagrams = [...box.querySelectorAll('pre.mermaid')];
    if (diagrams.length) {
      const mermaid = await loadVendor('mermaid');
      if (mermaid) {
        const dark = w.matchMedia?.('(prefers-color-scheme: dark)').matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        await mermaid.run({ nodes: diagrams }).catch(() => {});
      }
    }
    const codes = [...box.querySelectorAll('pre > code')];
    if (codes.length) {
      const hljs = await loadVendor('hljs');
      if (hljs) for (const c of codes) if (/language-/.test(c.className)) hljs.highlightElement(c);
    }
  }

  function scrollToAnchor(container, anchor) {
    const target = [...container.querySelectorAll('[id]')].find((e) => e.id === anchor);
    target?.scrollIntoView?.({ block: 'start' });
  }

  /** 본문 안 같은 문서 앵커(#제목)는 해시를 바꾸지 않고 그 자리로 옮긴다(해시는 화면의 정본이라서) */
  function onBodyClick(e) {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (HASH.test(href)) return; // 보드 안 이동
    e.preventDefault();
    const anchor = href.slice(1);
    scrollToAnchor($('wb-task-body'), anchor);
    const h = parseHash(w.location.hash);
    if (h && h.output !== null) w.history.replaceState(null, '', `${w.location.pathname}${w.location.search}${hashOf({ ...h, anchor })}`);
  }

  // ── 적재와 주기 갱신 ──
  /** 끝 커밋. 보드 서버의 마지막 fetch 상태도 함께 기억한다 */
  async function headCommit() {
    const h = await api.head();
    state.fetchedAt = h.fetchedAt ?? null;
    state.fetchError = h.fetchError ?? null;
    return h.commit;
  }

  async function load() {
    const commit = await headCommit();
    const src = await api.loadBoardSources(commit);
    return buildBoard({ boardText: src.boardText, projectsText: src.projectsText, tasks: src.tasks, ctx: { host: config.host ?? null, repo: config.repo ?? null, commit } });
  }

  function apply(next) {
    const h = parseHash(w.location.hash);
    const hadOpen = h && taskById(h.id);
    state.data = next;
    setupFilters();
    renderHelp();
    renderBoard();
    renderBanner();
    renderStatus();
    state.deletedId = hadOpen && !taskById(h.id) ? h.id : null;
    renderPopup();
  }

  async function check() {
    try {
      const commit = await headCommit();
      state.lastCheck = new Date().toISOString();
      state.failed = false;
      if (commit !== state.data.commit.sha) {
        const next = await load();
        // 열람 중인 기록은 다시 받지 않는다(읽던 위치 유지). 새 커밋에서 내용이 바뀌었을 때만 "새 버전"을 보인다
        const v = state.viewer;
        if (v?.text) {
          const text = await api.readFile(v.path, commit).catch(() => v.text);
          if (text === v.text) v.key = `${commit}:${v.path}`;
          else state.staleViewer = true;
        }
        apply(next);
      } else renderStatus();
    } catch (e) {
      if (e instanceof ParseError) {
        state.banner = `보드 설정을 읽지 못해 이전 내용을 보여 준다: ${e.message}`;
        renderBanner();
      }
      state.failed = true;
      renderStatus();
    }
  }

  let pollTimer = null;
  function schedule() {
    w.clearInterval(pollTimer);
    pollTimer = doc.hidden || !state.data ? null : w.setInterval(check, config.pollMs);
  }

  /** 보드를 그리지 못할 때 보드 자리에 이유를 보인다 */
  function showGate(message) {
    $('wb-board').replaceChildren(el('div', { class: 'gate' }, el('p', {}, message)));
  }

  function bind() {
    $('wb-filters').addEventListener('input', writeFilters);
    $('wb-filters').addEventListener('submit', (e) => e.preventDefault());
    // 작성자 목록: 버튼으로 펼치고, Esc·바깥 클릭으로 닫는다. 닫아도 고른 값은 URL에 남는다
    $('wb-f-author').addEventListener('click', () => setAuthorList($('wb-f-author-list').hidden));
    $('wb-f-author-clear').addEventListener('click', () => {
      for (const box of $('wb-f-author-options').querySelectorAll('input[name="author"]')) box.checked = false;
      writeFilters();
    });
    $('wb-f-author-box').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('wb-f-author-list').hidden) { e.preventDefault(); setAuthorList(false, { focusButton: true }); }
    });
    doc.addEventListener('click', (e) => { if (!$('wb-f-author-list').hidden && !$('wb-f-author-box').contains(e.target)) setAuthorList(false); });
    w.addEventListener('hashchange', renderPopup);
    $('wb-task-close').addEventListener('click', closeTask);
    $('wb-task-dialog').addEventListener('cancel', (e) => { e.preventDefault(); closeTask(); }); // Esc
    $('wb-task-dialog').addEventListener('click', (e) => { if (e.target === $('wb-task-dialog')) closeTask(); }); // 바깥 클릭
    $('wb-task-body').addEventListener('click', onBodyClick);
    bindNewDialog();
    $('wb-help-toggle').addEventListener('click', () => {
      const open = $('wb-help').hidden;
      $('wb-help').hidden = !open;
      $('wb-help-toggle').setAttribute('aria-expanded', String(open));
    });
    doc.addEventListener('visibilitychange', () => {
      schedule();
      if (!doc.hidden && state.data) check();
    });
  }

  async function start() {
    bind();
    // push하지 않은 작업 트리를 함께 보여 주는 중이면 머리에 표시한다(반드시)
    if ($('wb-mode')) $('wb-mode').hidden = !config.worktree;
    try {
      apply(await load());
      $('wb-new-open').hidden = false;
      state.lastCheck = new Date().toISOString();
      renderStatus();
    } catch (e) {
      showGate(`보드를 읽지 못했다: ${e.message}`);
      return;
    }
    schedule();
  }

  return { start, check, state };
}

/** 기본 클립보드 쓰기. 보안 출처(HTTPS·127.0.0.1)와 클릭 안에서만 된다. 없으면 실패로 다뤄 대체 입력란을 연다 */
function defaultCopy(w) {
  return async (text) => {
    if (!w.navigator?.clipboard?.writeText) throw new Error('클립보드를 쓸 수 없다');
    await w.navigator.clipboard.writeText(text);
  };
}
