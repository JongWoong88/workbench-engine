// 보드 사이트의 모델(site/src/board-model.mjs)과 링크 규칙(site/src/links.mjs).
// bin/의 보드 모델 시험(board-model.test.mjs)과 다르다. hooks/test_board.py의 사례를 옮겼다(mark_details·record_url 제외).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, loadProjects, recordTitle } from '../site/src/board-model.mjs';
import { parseBase, resolveHref, normalize, hostUrls } from '../site/src/links.mjs';
import { ParseError } from '../plugin/cli/lib/model/errors.mjs';

const PROJECTS = '# project\tkey\trepos\tgitlab\n'
  + 'app\tAPP\tws/app\tgrp/app\n'
  + 'event\tEVT\tws/event,ws/web\t-,grp/web\n'
  + 'common\tCMN\t-\t-\n';
const BOARD_YML = `columns:
  - {id: backlog, label: 📋 Backlog, state: waiting, color: '#8a9099'}
  - {id: design, label: 📐 Design, state: active}
  - {id: done, label: ✅ Done, state: closed}
description: |
  **📋 Backlog** 착수 전
`;
const BASE = { host: { type: 'gitlab', web: 'https://git.example' }, repo: 'grp/wb', commit: 'c0ffee1234' };
const ctx = (host = BASE.host) => ({ urls: hostUrls(host), repo: BASE.repo, commit: BASE.commit, projects: loadProjects(PROJECTS) });

test('projects.tsv: 저장소 → remote 경로, remote 열 불일치는 ParseError', () => {
  const p = loadProjects(PROJECTS);
  assert.deepEqual([...p.gitlabByRepo], [['ws/app', 'grp/app'], ['ws/web', 'grp/web']]);
  assert.throws(() => loadProjects('x\tX\ta/r1,a/r2\tg/r1\n'), (e) => e instanceof ParseError && e.code === 'TSV-REMOTE');
  assert.throws(() => loadProjects('x\tX\ta/r1\n'), (e) => e instanceof ParseError);
});

test('base 형식', () => {
  const p = loadProjects(PROJECTS);
  assert.deepEqual(parseBase('main@abc1234', ['app'], p), { 'ws/app': 'abc1234' });
  assert.deepEqual(parseBase({ 'web': 'develop@5d30762', 'app': 'master@137bffe2' }, ['web', 'app'], p),
    { 'ws/web': '5d30762', 'ws/app': '137bffe2' });
  assert.deepEqual(parseBase('none', [], p), {});
  assert.deepEqual(parseBase('unknown', ['app'], p), {});
  assert.deepEqual(parseBase('main@abc1234', ['web', 'app'], p), {}); // 저장소가 여럿인데 커밋이 하나면 정할 수 없다
});

const REC = 'records/common/CMN-8/design.md';
const rw = (href, src = REC, shas = {}) => resolveHref(href, src, ctx(), shas);

test('L-1: records 마크다운은 기록, 그 밖의 records 파일은 호스트 파일 보기', () => {
  assert.deepEqual(rw('proposal.md'), { kind: 'record', path: 'records/common/CMN-8/proposal.md', anchor: '' });
  assert.deepEqual(rw('../CMN-2/x.md#a'), { kind: 'record', path: 'records/common/CMN-2/x.md', anchor: 'a' });
  assert.deepEqual(rw('design/Fig1.png'), { kind: 'host', path: 'records/common/CMN-8/design/Fig1.png', url: 'https://git.example/grp/wb/-/blob/c0ffee1234/records/common/CMN-8/design/Fig1.png' });
});

test('L-1: 퍼센트 인코딩·한글 경로와 앵커', () => {
  assert.deepEqual(rw('sub/Fig1-1_%ED%98%84%ED%96%89.png'), { kind: 'host', path: 'records/common/CMN-8/sub/Fig1-1_현행.png', url: 'https://git.example/grp/wb/-/blob/c0ffee1234/records/common/CMN-8/sub/Fig1-1_%ED%98%84%ED%96%89.png' });
  assert.deepEqual(rw('discovery.md#d-1-저장소-상태'), { kind: 'record', path: 'records/common/CMN-8/discovery.md', anchor: 'd-1-저장소-상태' });
  assert.deepEqual(rw('a%20b.md'), { kind: 'record', path: 'records/common/CMN-8/a b.md', anchor: '' });
});

test('L-2: 이슈 파일은 보드 팝업', () => {
  assert.deepEqual(rw('../../../board/tasks/APP-1.md'), { kind: 'task', id: 'APP-1' });
  assert.deepEqual(rw('APP-1.md', 'board/tasks/CMN-8.md'), { kind: 'task', id: 'APP-1' });
});

test('L-3: 문서 저장소의 다른 파일은 읽은 커밋의 호스트 주소', () => {
  assert.equal(rw('../../../bin/lib/taskid.mjs#L10').url, 'https://git.example/grp/wb/-/blob/c0ffee1234/bin/lib/taskid.mjs#L10');
});

test('L-4: 저장소 링크는 base 커밋, 없으면 HEAD', () => {
  const href = '../../../../ws/app/src/Main.java';
  assert.equal(rw(href, REC, { 'ws/app': '137bffe2' }).url, 'https://git.example/grp/app/-/blob/137bffe2/src/Main.java');
  assert.equal(rw(href).url, 'https://git.example/grp/app/-/blob/HEAD/src/Main.java');
  assert.equal(rw('../../../ws/web/docs/a.md#x', 'board/tasks/CMN-8.md').url, 'https://git.example/grp/web/-/blob/HEAD/docs/a.md#x');
});

test('호스트: github 형식, 설정이 없으면 문서 저장소 파일은 주소 없이 두고 저장소 링크는 경고', () => {
  const gh = (href, src = REC, shas = {}) => resolveHref(href, src, ctx({ type: 'github', web: 'https://github.com' }), shas);
  assert.equal(gh('../../../bin/x.mjs#L1').url, 'https://github.com/grp/wb/blob/c0ffee1234/bin/x.mjs#L1');
  assert.equal(gh('../../../../ws/app/src/Main.java').url, 'https://github.com/grp/app/blob/HEAD/src/Main.java');
  const none = (href) => resolveHref(href, REC, ctx(null));
  assert.deepEqual(none('design/Fig1.png'), { kind: 'host', path: 'records/common/CMN-8/design/Fig1.png', url: null });
  const repo = none('../../../../ws/app/src/Main.java');
  assert.equal(repo.kind, 'unresolved');
  assert.match(repo.warning, /호스트 설정/);
});

test('L-5: 풀 수 없는 링크는 경고와 함께 그대로', () => {
  const a = rw('../../../../ws/event/a.md'); // remote 경로가 없는(-) 저장소
  assert.equal(a.kind, 'unresolved');
  assert.match(a.warning, /ws\/event/);
  assert.equal(rw('../../../../other/nope/a.md').kind, 'unresolved');
});

test('절대 주소와 같은 문서 앵커는 그대로', () => {
  for (const href of ['https://x.y/z', '#section', 'mailto:a@b', '/abs/path']) assert.deepEqual(rw(href), { kind: 'keep' });
});

test('경로 정규화', () => {
  assert.equal(normalize('records/a/../b/./c.md'), 'records/b/c.md');
  assert.equal(normalize('records/a/../../../x'), '../x');
});

test('보드 조립: children, 종료, 산출물, 오류 이슈 제외, 시각은 문자열', () => {
  const tasks = [
    { path: 'board/tasks/CMN-8.md', text: "---\ntask_id: CMN-8\ntitle: Parent\nproject: common\ntype: research\ncolumn: design\ncreated: '2026-10-01T00:00:00.000Z'\nstarted: 2026-10-02T00:00:00.000Z\n"
      + 'outputs:\n  - kind: 설계\n    path: records/common/CMN-8/design.md\n    desc: 구조\n  - kind: 문서\n    path: ../ws/app/docs/a.md\n  - kind: 검토\n    path: records/common/CMN-8/review.md#s-1\n'
      + 'history:\n  - {type: created, date: 2026-10-01T00:00:00.000Z, author: A, column: design}\n---\n\n[자식](APP-1.md)\n' },
    { path: 'board/tasks/APP-1.md', text: "---\ntask_id: APP-1\ntitle: Child\nproject: app\ntype: feature\ncolumn: done\nparent: CMN-8\ncreated: '2026-10-01T00:00:00.000Z'\nhistory: []\n---\n" },
    { path: 'board/tasks/BROKEN-1.md', text: '---\ntitle: [\n---\n' },
  ];
  const out = buildBoard({ boardText: BOARD_YML, projectsText: PROJECTS, tasks, ctx: BASE });
  assert.deepEqual(out.commit, { sha: 'c0ffee1234', short: 'c0ffee1' });
  assert.deepEqual(out.board.columns.map((c) => c.id), ['backlog', 'design', 'done']);
  assert.match(out.board.description, /Backlog/);
  assert.equal(out.projects.app.repos[0].url, 'https://git.example/grp/app');
  const byId = Object.fromEntries(out.tasks.map((t) => [t.task_id, t]));
  assert.deepEqual(Object.keys(byId), ['APP-1', 'CMN-8']);
  const p = byId['CMN-8'];
  assert.deepEqual(p.children, ['APP-1']);
  assert.equal(p.closed, false);
  assert.equal(byId['APP-1'].closed, true);
  assert.equal(p.body, '\n[자식](APP-1.md)\n'.slice(1));
  assert.equal(p.started, '2026-10-02T00:00:00.000Z');
  assert.equal(p.history[0].date, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(p.outputs[0], { kind: '설계', path: 'records/common/CMN-8/design.md', desc: '구조', title: 'design.md', missing: null, record: 'records/common/CMN-8/design.md', anchor: '', url: null, external: false });
  assert.equal(p.outputs[1].url, 'https://git.example/grp/app/-/blob/HEAD/docs/a.md');
  assert.equal(p.outputs[1].external, true);
  assert.equal(p.outputs[2].record, 'records/common/CMN-8/review.md');
  assert.equal(p.outputs[2].anchor, 's-1');
  assert.equal(out.errors[0].file, 'board/tasks/BROKEN-1.md');
});

test('보드 조립: board.yml·projects.tsv 오류는 ParseError', () => {
  assert.throws(() => buildBoard({ boardText: 'columns: [\n', projectsText: PROJECTS, tasks: [], ctx: BASE }), ParseError);
  assert.throws(() => buildBoard({ boardText: BOARD_YML, projectsText: 'x\tX\ta/r1\n', tasks: [], ctx: BASE }), ParseError);
});

test('기록 제목: 프론트매터 title → H1 → 파일명', () => {
  assert.equal(recordTitle('---\ntitle: 설계 문서\n---\n\n# 다른 제목\n', 'r/a.md'), '설계 문서');
  assert.equal(recordTitle('# 제목만\n', 'r/a.md'), '제목만');
  assert.equal(recordTitle('본문\n', 'r/a.md'), 'a.md');
});
