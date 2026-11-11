// 보드 화면(site/src/app.mjs)을 jsdom에서 확인한다. 보드 API는 흉내 낸다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createApp, parseHash, hashOf } from '../site/src/app.mjs';
import { createRenderer } from '../site/src/render.mjs';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site');
const HTML = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').replace(/<script[^>]*><\/script>/, '');
const BOARD_YML = 'columns:\n  - {id: backlog, label: "🗑️ Backlog", state: waiting}\n  - {id: doing, label: Doing, state: active}\n  - {id: done, label: "✅ Done", state: closed}\n  - {id: dropped, label: Dropped, state: closed}\nviews:\n  - {id: v1, label: 진행, columns: [doing]}\ndescription: |\n  **Backlog** 대기\n';
const PROJECTS = '# project\tkey\trepos\tgitlab\ncommon\tK\t-\t-\nother\tO\t-\t-\n';
const task = (id, { column = 'doing', project = 'common', extra = '', body = '' } = {}) =>
  ({ path: `board/tasks/${id}.md`, text: `---\ntask_id: ${id}\ntitle: 제목 ${id}\nproject: ${project}\ntype: research\ncolumn: ${column}\ncreated: '2026-10-01T00:00:00.000Z'\n${extra}---\n${body}` });
const REC = 'records/common/K-1/design.md';
const RECORD = '---\ntitle: 설계 문서\n---\n\n# 설계\n\n[결론으로](#결론) · [다른 기록](other.md) · [코드](../../../bin/x.mjs)\n\n## 결론\n\n끝\n';

const windows = [];
after(() => { for (const w of windows) w.close(); });

const GITLAB = { type: 'gitlab', web: 'https://git.example' };
function setup({ tasks, files = {}, url = 'http://127.0.0.1:47800/', failStart, boardText = BOARD_YML, copyText, copiedMs = 1e9, host = GITLAB, worktree = false } = {}) {
  const dom = new JSDOM(HTML, { url, pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  const repo = {
    commit: 'c1',
    tasks: tasks ?? [
      task('K-1', { extra: `outputs:\n  - kind: 설계\n    path: ${REC}\n    desc: 구조\n`, body: '\n[설계](../../records/common/K-1/design.md)\n' }),
      task('K-2', { column: 'backlog', project: 'other' }),
      task('K-3', { column: 'done', extra: 'archived: true\n' }),
    ],
    files: { [REC]: RECORD, 'records/common/K-1/other.md': '# 다른\n', ...files },
    boardText,
  };
  const calls = { readFile: 0, load: 0 };
  const data = {
    async head() { if (failStart) throw failStart; return { commit: repo.commit, fetchedAt: repo.fetchedAt ?? null, fetchError: repo.fetchError ?? null }; },
    async loadBoardSources(commit) { calls.load++; return { commit, boardText: repo.boardText, projectsText: PROJECTS, tasks: repo.tasks }; },
    async readPaths(paths) { return Object.fromEntries(paths.map((p) => [p, repo.files[p] ?? null])); },
    async readFile(p) { calls.readFile++; return repo.files[p] ?? null; },
    async readBinary() { return null; },
    async lastCommit() { return 'rc1'; },
  };
  const app = createApp({ window: w, data, render: createRenderer(w), config: { host, repo: 'grp/wb', branch: 'main', pollMs: 1e9, copiedMs, worktree }, ...(copyText ? { copyText } : {}) });
  return { w, doc: w.document, app, repo, data, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const go = async (w, hash) => { w.location.hash = hash; await settle(); };
const ids = (doc) => [...doc.querySelectorAll('.card')].map((c) => c.dataset.id);

test('해시 문법: 기존 #ID·#ID/n과 기록 이동 r·a', () => {
  assert.deepEqual(parseHash('#K-1'), { id: 'K-1', output: null, record: null, anchor: null });
  assert.deepEqual(parseHash('#K-1/2'), { id: 'K-1', output: 2, record: null, anchor: null });
  const h = { id: 'K-1', output: 'r', record: 'records/a/b c.md', anchor: '결론' };
  assert.deepEqual(parseHash(hashOf(h)), h);
  assert.equal(parseHash('#결론'), null);
});

test('보드: 카드, 보관 숨김, 거르기, 워크플로 설명 렌더링', async () => {
  const { doc, app, w } = setup();
  await app.start();
  assert.deepEqual(ids(doc), ['K-2', 'K-1']);
  assert.match(doc.getElementById('wb-status').textContent, /기준 커밋 c1 · 이슈 3개/);
  assert.equal(doc.querySelector('#wb-help strong').textContent, 'Backlog');
  w.history.replaceState(null, '', '?archived=1&project=common');
  doc.getElementById('wb-filters').dispatchEvent(new w.Event('input'));
  const { doc: d2, app: a2 } = setup({ url: 'https://docs.example/g/p/?archived=1&project=common' });
  await a2.start();
  assert.deepEqual(ids(d2), ['K-1', 'K-3']);
});

const AUTHOR_TASKS = () => [
  task('K-1', { extra: 'author: 가\n' }),
  task('K-2', { project: 'other', extra: 'author: 나\n' }),
  task('K-3', { column: 'backlog', extra: 'author: 다\n' }),
  task('K-4'),
];
const authorOptions = (doc) => [...doc.querySelectorAll('#wb-f-author-list input[name="author"]')].map((i) => [i.value, i.checked]);
const toggleAuthor = (doc, w, name) => {
  const box = doc.querySelector(`#wb-f-author-list input[value="${name}"]`);
  box.checked = !box.checked;
  box.dispatchEvent(new w.Event('input', { bubbles: true }));
};
const authorQuery = (w) => new URLSearchParams(w.location.search).getAll('author');

test('작성자 거르기: 체크박스로 여럿을 고르고 URL에 author를 반복해 남긴다', async () => {
  const { doc, app, w } = setup({ tasks: AUTHOR_TASKS() });
  await app.start();
  const button = doc.getElementById('wb-f-author');
  const list = doc.getElementById('wb-f-author-list');
  assert.deepEqual(ids(doc).sort(), ['K-1', 'K-2', 'K-3', 'K-4']);
  assert.equal(button.textContent, '작성자 전체');
  assert.equal(list.hidden, true);
  button.click();
  assert.equal(list.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(authorOptions(doc), [['가', false], ['나', false], ['다', false]]);
  toggleAuthor(doc, w, '가');
  assert.deepEqual(ids(doc), ['K-1']);
  assert.deepEqual(authorQuery(w), ['가']);
  toggleAuthor(doc, w, '나');
  assert.deepEqual(ids(doc).sort(), ['K-1', 'K-2']);
  assert.deepEqual(authorQuery(w), ['가', '나']);
  assert.equal(button.textContent, '작성자 2');
  // 다른 거르기와는 AND
  doc.getElementById('wb-f-project').value = 'other';
  doc.getElementById('wb-filters').dispatchEvent(new w.Event('input'));
  assert.deepEqual(ids(doc), ['K-2']);
  assert.deepEqual(authorQuery(w), ['가', '나']);
  doc.getElementById('wb-f-project').value = '';
  doc.getElementById('wb-f-author-clear').click();
  assert.deepEqual(ids(doc).sort(), ['K-1', 'K-2', 'K-3', 'K-4']);
  assert.deepEqual(authorQuery(w), []);
  assert.equal(button.textContent, '작성자 전체');
});

test('작성자 거르기: URL에서 복원하고, URL에만 있는 이름도 체크된 채 보인다', async () => {
  const { doc, app } = setup({ tasks: AUTHOR_TASKS(), url: 'https://docs.example/g/p/?author=%EA%B0%80&author=%EC%97%86%EC%9D%8C' });
  await app.start();
  assert.deepEqual(ids(doc), ['K-1']); // author가 없는 K-4는 작성자를 고르면 빠진다
  assert.deepEqual(authorOptions(doc), [['가', true], ['나', false], ['다', false], ['없음', true]]);
  assert.equal(doc.getElementById('wb-f-author').textContent, '작성자 2');
});

test('작성자 거르기: 갱신 뒤에도 펼침·체크·포커스를 유지하고, Esc·바깥 클릭으로 닫힌다', async () => {
  const { doc, app, w, repo } = setup({ tasks: AUTHOR_TASKS() });
  await app.start();
  const button = doc.getElementById('wb-f-author');
  const list = doc.getElementById('wb-f-author-list');
  button.click();
  toggleAuthor(doc, w, '가');
  doc.querySelector('#wb-f-author-list input[value="가"]').focus();
  repo.tasks = [...repo.tasks, task('K-5', { extra: 'author: 라\n' })];
  repo.commit = 'c2';
  await app.check();
  assert.equal(list.hidden, false);
  assert.deepEqual(authorOptions(doc), [['가', true], ['나', false], ['다', false], ['라', false]]);
  assert.equal(doc.activeElement?.value, '가');
  assert.deepEqual(ids(doc), ['K-1']);
  list.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(list.hidden, true);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(doc.activeElement, button);
  button.click();
  assert.equal(list.hidden, false);
  doc.getElementById('wb-board').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(list.hidden, true);
  assert.deepEqual(authorQuery(w), ['가']); // 닫아도 고른 값은 남는다
});

test('팝업: 이슈 상세, 산출물 제목 채우기, 본문의 기록 링크', async () => {
  const { doc, app, w } = setup();
  await app.start();
  await go(w, '#K-1');
  assert.ok(doc.getElementById('wb-task-dialog').open);
  assert.match(doc.getElementById('wb-task-title').textContent, /K-1 제목 K-1/);
  assert.match(doc.querySelector('.outputs').textContent, /설계 문서/);
  assert.doesNotMatch(doc.querySelector('.outputs').textContent, /구조/); // 부가설명(desc)은 목록에 보이지 않는다
  assert.equal(doc.querySelector('#wb-task-body .md a').getAttribute('href'), '#K-1/0');
  // 컬럼·project·유형은 속성 표가 아니라 뱃지 한 줄로
  const badges = [...doc.querySelectorAll('.task-badges .badge')].map((b) => [b.className, b.textContent]);
  assert.deepEqual(badges, [['badge stage', 'Doing'], ['badge project', 'common'], ['badge type type-research', 'research']]);
  assert.doesNotMatch(doc.querySelector('.task-meta').textContent, /컬럼|유형/);
});

test('팝업: 작성자는 "담당" 앞의 "작성" 줄에 보이고, 카드에는 보이지 않는다', async () => {
  const { doc, app, w } = setup({ tasks: [task('K-1', { extra: 'author: 작성이\nassigned: 담당이\n' }), task('K-2')] });
  await app.start();
  assert.doesNotMatch(doc.querySelector('.card[data-id="K-1"]').textContent, /작성이/);
  await go(w, '#K-1');
  const meta = (d) => [...d.querySelectorAll('.task-meta dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent]);
  assert.deepEqual(meta(doc).slice(0, 2), [['작성', '작성이'], ['담당', '담당이']]);
  await go(w, '#K-2');
  assert.deepEqual(meta(doc)[0], ['작성', '—']);
});

test('팝업: 상위 이슈는 하위 이슈를 표로, 하위 이슈는 머리의 한 줄로 상위를 보인다', async () => {
  const { doc, app, w } = setup({ tasks: [task('K-1'), task('K-2', { column: 'done', extra: 'parent: K-1\n' }), task('K-3', { column: 'backlog', extra: 'parent: K-1\n' })] });
  await app.start();
  await go(w, '#K-1');
  const rows = [...doc.querySelectorAll('table.children tbody tr')].map((tr) => [...tr.cells].map((c) => c.textContent));
  assert.deepEqual(rows, [['K-2', '제목 K-2', 'Done'], ['K-3', '제목 K-3', 'Backlog']]);
  doc.querySelector('table.children button').click();
  await settle();
  assert.equal(w.location.hash, '#K-2');
  assert.match(doc.querySelector('.task-meta').textContent, /상위 이슈K-1 제목 K-1 Doing/);
  assert.equal(doc.querySelector('table.children'), null);
  assert.ok(![...doc.querySelectorAll('.task-section h3')].some((h) => /연결/.test(h.textContent)));
});

test('기록 뷰어: 렌더링, 같은 문서 앵커는 해시 라우트를 바꾸지 않음, 다른 기록은 r로', async () => {
  const { doc, app, w } = setup();
  await app.start();
  await go(w, '#K-1/0');
  const body = doc.getElementById('wb-task-body');
  assert.match(doc.getElementById('wb-task-title').textContent, /설계: 설계 문서/);
  assert.ok(body.querySelector('h2#결론'));
  const links = [...body.querySelectorAll('a')];
  links.find((a) => a.textContent === '결론으로').click();
  await settle();
  assert.deepEqual(parseHash(w.location.hash), { id: 'K-1', output: 0, record: null, anchor: '결론' });
  assert.ok(doc.getElementById('wb-task-dialog').open);
  assert.equal(links.find((a) => a.textContent === '코드').getAttribute('href'), 'https://git.example/grp/wb/-/blob/rc1/bin/x.mjs'); // 기록의 마지막 커밋
  const other = links.find((a) => a.textContent === '다른 기록').getAttribute('href');
  assert.deepEqual(parseHash(other), { id: 'K-1', output: 'r', record: 'records/common/K-1/other.md', anchor: null });
  await go(w, other);
  assert.equal(body.querySelector('h1').textContent, '다른');
});

test('새로고침해도 기록 이동 위치를 복원한다', async () => {
  const { doc, app } = setup({ url: `https://docs.example/g/p/${hashOf({ id: 'K-1', output: 'r', record: 'records/common/K-1/other.md' })}` });
  await app.start();
  await settle();
  assert.equal(doc.querySelector('#wb-task-body h1').textContent, '다른');
});

test('갱신: 같은 커밋은 다시 읽지 않고, 새 커밋은 다시 그리며 팝업을 유지한다', async () => {
  const { doc, app, repo, calls, w } = setup();
  await app.start();
  await go(w, '#K-1');
  await app.check();
  assert.equal(calls.load, 1);
  repo.commit = 'c2';
  repo.tasks = [...repo.tasks, task('K-4', { column: 'backlog' })];
  await app.check();
  await settle();
  assert.equal(calls.load, 2);
  assert.ok(ids(doc).includes('K-4'));
  assert.ok(doc.getElementById('wb-task-dialog').open);
  assert.match(doc.getElementById('wb-status').textContent, /c2/);
});

test('갱신: 열람 중 기록이 그대로면 "새 버전"이 없고, 바뀌면 보인다. 다시 받지 않아 읽던 위치를 유지한다', async () => {
  const { doc, app, repo, w } = setup();
  await app.start();
  await go(w, '#K-1/0');
  const before = doc.querySelector('#wb-task-body .md');
  repo.commit = 'c2';
  await app.check();
  await settle();
  assert.equal(doc.querySelector('#wb-task-body .md'), before);
  assert.ok(![...doc.querySelectorAll('#wb-task-actions button')].some((b) => b.textContent === '새 버전 불러오기'));
  repo.commit = 'c3';
  repo.files[REC] = RECORD.replace('끝', '바뀜');
  await app.check();
  await settle();
  assert.equal(doc.querySelector('#wb-task-body .md'), before);
  const reload = [...doc.querySelectorAll('#wb-task-actions button')].find((b) => b.textContent === '새 버전 불러오기');
  assert.ok(reload);
  reload.click();
  await settle();
  assert.match(doc.getElementById('wb-task-body').textContent, /바뀜/);
});

test('갱신: 열어 둔 이슈가 지워지면 안내한다', async () => {
  const { doc, app, repo, w } = setup();
  await app.start();
  await go(w, '#K-2');
  repo.commit = 'c2';
  repo.tasks = repo.tasks.filter((t) => !t.path.includes('K-2'));
  await app.check();
  assert.match(doc.getElementById('wb-task-body').textContent, /K-2 이슈는 삭제되었다/);
});

test('갱신 중 보드 설정 오류는 이전 보드를 유지하고 경고한다. 네트워크 실패는 상태줄에', async () => {
  const { doc, app, repo, data } = setup();
  await app.start();
  repo.commit = 'c2';
  repo.boardText = 'columns: [\n';
  await app.check();
  assert.deepEqual(ids(doc), ['K-2', 'K-1']);
  assert.match(doc.getElementById('wb-errors').textContent, /보드 설정을 읽지 못해/);
  data.head = async () => { throw new Error('offline'); };
  await app.check();
  assert.match(doc.getElementById('wb-status').textContent, /갱신 실패/);
});

// ── 스킬 프롬프트 복사 ──
const PROMPT_TASKS = () => [
  task('K-1', { extra: `outputs:\n  - kind: 설계\n    path: ${REC}\n    desc: 구조\n` }),
  task('K-2', { column: 'backlog', extra: 'parent: K-1\n' }),
  task('K-3', { column: 'done' }),
  task('K-4', { column: 'dropped' }),
  task('K-5', { column: 'done', extra: 'archived: true\n' }),
];
const buttons = (doc) => [...doc.querySelectorAll('#wb-task-body .prompt-bar button')].map((b) => b.textContent);
const moveSelect = (doc) => doc.querySelector('#wb-task-body .prompt-bar select');
const choose = async (w, select, value) => { select.value = value; select.dispatchEvent(new w.Event('change')); await settle(); };
const clipboard = () => {
  const c = { texts: [], fail: false };
  c.copyText = async (text) => { if (c.fail) throw new Error('denied'); c.texts.push(text); };
  return c;
};

test('프롬프트 도구 막대: 상태별 버튼, 이동 옵션, 하위 이슈 안내, 완료 버튼 없음', async () => {
  const { doc, app, w } = setup({ tasks: PROMPT_TASKS() });
  await app.start();
  await go(w, '#K-1');
  assert.deepEqual(buttons(doc), ['이동 복사', '폐기 복사']);
  assert.deepEqual([...moveSelect(doc).options].map((o) => o.value), ['', 'backlog']);
  assert.ok(doc.querySelector('#wb-task-body .prompt-bar button').disabled);
  assert.match(doc.querySelector('.prompt-note').textContent, /끝나지 않은 하위 이슈 1개/);
  assert.equal(doc.querySelector('.task-badges .prompt-bar'), null); // 뱃지 줄 밖
  await go(w, '#K-3');
  assert.deepEqual(buttons(doc), ['이동 복사', '폐기 복사', '보관 복사']);
  assert.deepEqual([...moveSelect(doc).options].map((o) => o.value), ['', 'backlog', 'doing']);
  assert.equal(doc.querySelector('.prompt-note'), null);
  await go(w, '#K-4');
  assert.deepEqual(buttons(doc), ['이동 복사', '보관 복사']);
  await go(w, '#K-5');
  assert.deepEqual(buttons(doc), ['꺼내기 복사']);
  assert.equal(moveSelect(doc), null);
});

test('프롬프트 도구 막대: 보드에 dropped가 없으면 폐기를 숨기고, 기록 뷰어에는 막대가 없다', async () => {
  const { doc, app, w } = setup({ tasks: PROMPT_TASKS(), boardText: BOARD_YML.replace(/ {2}- \{id: dropped[^\n]*\n/, '') });
  await app.start();
  await go(w, '#K-1');
  assert.deepEqual(buttons(doc), ['이동 복사']);
  await go(w, '#K-1/0');
  assert.equal(doc.querySelector('.prompt-tools'), null);
});

test('프롬프트 복사: 고른 컬럼으로 복사하고 "복사됨"을 보였다가 되돌린다', async () => {
  const c = clipboard();
  const { doc, app, w } = setup({ tasks: PROMPT_TASKS(), copyText: c.copyText, copiedMs: 0 });
  await app.start();
  await go(w, '#K-3');
  await choose(w, moveSelect(doc), 'doing');
  const move = doc.querySelector('.prompt-move button');
  assert.equal(move.disabled, false);
  move.click();
  await tick();
  assert.equal(move.textContent, '복사됨');
  assert.match(doc.querySelector('#wb-task-dialog [aria-live]').textContent, /복사했다/);
  await settle();
  assert.equal(move.textContent, '이동 복사');
  [...doc.querySelectorAll('#wb-task-body .prompt-bar button')].find((b) => b.textContent === '폐기 복사').click();
  [...doc.querySelectorAll('#wb-task-body .prompt-bar button')].find((b) => b.textContent === '보관 복사').click();
  await settle();
  assert.deepEqual(c.texts, ['/workbench:update-task K-3 doing', '/workbench:update-task K-3 dropped', '/workbench:archive-task K-3']);
  await go(w, '#K-5');
  doc.querySelector('#wb-task-body .prompt-bar button').click();
  await settle();
  assert.equal(c.texts.at(-1), '/workbench:archive-task K-5 --restore');
});

test('프롬프트 복사: 클립보드가 거부하면 대체 입력란, 컬럼을 바꾸거나 다시 성공하면 닫힌다', async () => {
  const c = clipboard();
  c.fail = true;
  const { doc, app, w } = setup({ tasks: PROMPT_TASKS(), copyText: c.copyText });
  await app.start();
  await go(w, '#K-3');
  await choose(w, moveSelect(doc), 'backlog');
  doc.querySelector('.prompt-move button').click();
  await settle();
  const area = doc.querySelector('#wb-task-body .prompt-fallback textarea');
  assert.equal(area.value, '/workbench:update-task K-3 backlog');
  assert.ok(area.readOnly);
  assert.deepEqual([area.selectionStart, area.selectionEnd], [0, area.value.length]);
  await choose(w, moveSelect(doc), 'doing');
  assert.equal(doc.querySelector('#wb-task-body .prompt-fallback textarea'), null);
  doc.querySelector('.prompt-move button').click();
  await settle();
  assert.ok(doc.querySelector('#wb-task-body .prompt-fallback textarea'));
  c.fail = false;
  doc.querySelector('.prompt-move button').click();
  await settle();
  assert.equal(doc.querySelector('#wb-task-body .prompt-fallback textarea'), null);
});

test('프롬프트 복사: 클립보드를 주입하지 않으면(jsdom에는 없다) 대체 입력란이 열린다', async () => {
  const { doc, app, w } = setup({ tasks: PROMPT_TASKS() });
  await app.start();
  await go(w, '#K-3');
  [...doc.querySelectorAll('#wb-task-body .prompt-bar button')].find((b) => b.textContent === '보관 복사').click();
  await settle();
  assert.equal(doc.querySelector('#wb-task-body .prompt-fallback textarea').value, '/workbench:archive-task K-3');
});

test('프롬프트 도구 막대: 갱신·뷰어 왕복에도 선택과 대체 입력란을 유지하고, 옵션에서 빠지거나 팝업을 닫으면 초기화한다', async () => {
  const c = clipboard();
  c.fail = true;
  const { doc, app, w, repo } = setup({ tasks: PROMPT_TASKS(), copyText: c.copyText });
  await app.start();
  await go(w, '#K-1');
  await choose(w, moveSelect(doc), 'backlog');
  doc.querySelector('.prompt-move button').click();
  await settle();
  repo.commit = 'c2';
  await app.check();
  await settle();
  assert.equal(moveSelect(doc).value, 'backlog');
  assert.equal(doc.querySelector('#wb-task-body .prompt-fallback textarea').value, '/workbench:update-task K-1 backlog');
  await go(w, '#K-1/0');
  await go(w, '#K-1');
  assert.equal(moveSelect(doc).value, 'backlog');
  // 이슈가 backlog로 옮겨져 고른 컬럼이 옵션에서 빠졌다
  repo.commit = 'c3';
  repo.tasks = PROMPT_TASKS().map((t) => (t.path.endsWith('K-1.md') ? task('K-1', { column: 'backlog' }) : t));
  await app.check();
  await settle();
  assert.equal(moveSelect(doc).value, '');
  assert.equal(doc.querySelector('#wb-task-body .prompt-fallback textarea'), null);
  await choose(w, moveSelect(doc), 'doing');
  doc.getElementById('wb-task-close').click();
  await go(w, '#K-1');
  assert.equal(moveSelect(doc).value, '');
  await choose(w, moveSelect(doc), 'doing');
  await go(w, '#K-3');
  await go(w, '#K-1');
  assert.equal(moveSelect(doc).value, '');
});

test('새 이슈 프롬프트: 보드를 읽은 뒤에만 보이고, 해시를 바꾸지 않으며, 입력을 그대로 복사한다', async () => {
  const gate = setup({ failStart: new Error('down') });
  await gate.app.start();
  assert.ok(gate.doc.getElementById('wb-new-open').hidden);
  const c = clipboard();
  const { doc, app, w } = setup({ copyText: c.copyText });
  await app.start();
  const open = doc.getElementById('wb-new-open');
  assert.equal(open.hidden, false);
  const search = w.location.search;
  open.click();
  const dialog = doc.getElementById('wb-new-dialog');
  assert.ok(dialog.open);
  assert.equal(w.location.hash, '');
  const text = doc.getElementById('wb-new-text');
  const copy = doc.getElementById('wb-new-copy');
  assert.ok(copy.disabled);
  text.value = '  \n';
  text.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.ok(copy.disabled);
  text.value = ' 환불 버그 feature\n\n- 재현: "결제" 취소 $1 \n';
  text.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(copy.disabled, false);
  copy.click();
  await settle();
  assert.deepEqual(c.texts, ['/workbench:new-task 환불 버그 feature\n\n- 재현: "결제" 취소 $1']);
  assert.equal(w.location.search, search); // 거르기 쿼리가 바뀌지 않는다
  assert.equal(w.localStorage.length + w.sessionStorage.length, 0);
});

test('새 이슈 프롬프트: Esc·바깥 클릭·닫기로 닫히고 입력은 남는다. 해시가 바뀌면 닫힌다', async () => {
  const c = clipboard();
  c.fail = true;
  const { doc, app, w } = setup({ copyText: c.copyText });
  await app.start();
  const dialog = doc.getElementById('wb-new-dialog');
  const text = doc.getElementById('wb-new-text');
  doc.getElementById('wb-new-open').click();
  text.value = '제목';
  text.dispatchEvent(new w.Event('input', { bubbles: true }));
  doc.getElementById('wb-new-copy').click();
  await settle();
  assert.equal(doc.querySelector('#wb-new-fallback textarea').value, '/workbench:new-task 제목');
  text.value = '제목 고침';
  text.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(doc.querySelector('#wb-new-fallback textarea'), null);
  dialog.dispatchEvent(new w.Event('cancel', { cancelable: true }));
  assert.equal(dialog.open, false);
  doc.getElementById('wb-new-open').click();
  assert.equal(text.value, '제목 고침');
  dialog.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(dialog.open, false);
  doc.getElementById('wb-new-open').click();
  doc.getElementById('wb-new-close').click();
  assert.equal(dialog.open, false);
  doc.getElementById('wb-new-open').click();
  await go(w, '#K-1');
  assert.equal(dialog.open, false);
  assert.ok(doc.getElementById('wb-task-dialog').open);
  doc.getElementById('wb-task-close').click();
});

test('보드 서버에 닿지 못하면 보드 자리에 이유를 보인다', async () => {
  const { doc, app } = setup({ failStart: new Error('보드 서버에 연결하지 못했다') });
  await app.start();
  assert.match(doc.querySelector('.gate').textContent, /보드를 읽지 못했다: 보드 서버에 연결하지 못했다/);
  assert.equal(doc.querySelector('.gate button'), null); // 로그인 같은 버튼이 없다
});

test('호스트 링크: github 형식, 호스트 설정이 없으면 링크를 만들지 않는다', async () => {
  const gh = setup({ host: { type: 'github', web: 'https://github.com' } });
  await gh.app.start();
  await go(gh.w, '#K-1');
  const file = [...gh.doc.querySelectorAll('.task-meta a')].find((a) => a.textContent === 'board/tasks/K-1.md');
  assert.equal(file.getAttribute('href'), 'https://github.com/grp/wb/blob/c1/board/tasks/K-1.md');
  await go(gh.w, '#K-1/0');
  const code = [...gh.doc.querySelectorAll('#wb-task-body .md a')].find((a) => a.textContent === '코드');
  assert.equal(code.getAttribute('href'), 'https://github.com/grp/wb/blob/rc1/bin/x.mjs');
  assert.ok([...gh.doc.querySelectorAll('#wb-task-actions a')].some((a) => a.textContent === '원격에서 열기'));

  const none = setup({ host: null });
  await none.app.start();
  await go(none.w, '#K-1');
  assert.equal([...none.doc.querySelectorAll('.task-meta a')].find((a) => a.textContent === 'board/tasks/K-1.md'), undefined);
  assert.ok(none.doc.querySelector('.task-meta').textContent.includes('board/tasks/K-1.md'));
  await go(none.w, '#K-1/0');
  const plain = [...none.doc.querySelectorAll('#wb-task-body .md a')].find((a) => a.textContent === '코드');
  assert.equal(plain.hasAttribute('href'), false);
  assert.ok(![...none.doc.querySelectorAll('#wb-task-actions a')].some((a) => a.textContent === '원격에서 열기'));
});

test('--worktree면 머리에 push 전 내용 포함을 보이고, 상태줄에 마지막 fetch를 보인다', async () => {
  const wt = setup({ worktree: true });
  wt.repo.fetchedAt = '2026-11-11T00:00:00.000Z';
  wt.repo.fetchError = 'timeout';
  await wt.app.start();
  assert.equal(wt.doc.getElementById('wb-mode').hidden, false);
  assert.match(wt.doc.getElementById('wb-mode').textContent, /push 전 내용 포함/);
  assert.match(wt.doc.getElementById('wb-status').textContent, /마지막 fetch .* fetch 실패: timeout/);
  const normal = setup();
  await normal.app.start();
  assert.ok(normal.doc.getElementById('wb-mode').hidden);
});

test('작성자: author가 없는 옛 이슈는 history 첫 항목의 작성자로 보이고 거른다', async () => {
  const history = ['history:', '  - type: created', "    date: '2026-10-01T00:00:00.000Z'", '    author: 옛사람', '    column: doing', ''].join('\n');
  const { doc, app, w } = setup({ tasks: [task('K-1', { extra: history })] });
  await app.start();
  assert.deepEqual([...doc.querySelectorAll('#wb-f-author-list input[name="author"]')].map((i) => i.value), ['옛사람']);
  await go(w, '#K-1');
  assert.match(doc.querySelector('.task-meta').textContent, /작성옛사람/);
});
