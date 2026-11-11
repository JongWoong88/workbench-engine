// 보드 사이트 렌더러(site/src/render.mjs): CommonMark 렌더링, 정화, 링크·이미지 변환. 결과는 렌더러 최종 출력으로 확인한다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRenderer } from '../site/src/render.mjs';
import { loadProjects } from '../site/src/board-model.mjs';
import { hostUrls } from '../site/src/links.mjs';

const { window } = new JSDOM('<!doctype html><body></body>');
const render = createRenderer(window);
const PROJECTS = '# project\tkey\trepos\tgitlab\napp\tAPP\tws/app\tgrp/app\n';
const ctx = { urls: hostUrls({ type: 'gitlab', web: 'https://git.example' }), repo: 'grp/wb', commit: 'c0ffee1234', projects: loadProjects(PROJECTS) };
const route = { record: (p, a) => `#R=${p}${a ? `~${a}` : ''}`, task: (id) => `#${id}` };
const REC = 'records/common/CMN-8/design.md';

function html(md, opts = {}) {
  const r = render(md, { srcRel: REC, ctx, route, ...opts });
  const div = window.document.createElement('div');
  div.append(r.fragment);
  return { div, warnings: r.warnings, data: r.data };
}
const q = (div, sel) => [...div.querySelectorAll(sel)];

test('2칸 들여쓰기 하위 목록과 체크박스', () => {
  const { div } = html('- 상위\n  - 하위\n- [ ] 할 일\n- [x] 끝\n');
  assert.equal(q(div, 'li > ul').length, 1);
  const boxes = q(div, 'input[type=checkbox]');
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => b.hasAttribute('disabled')));
  assert.equal(boxes.filter((b) => b.checked || b.hasAttribute('checked')).length, 1);
});

test('한글 제목 앵커(깃랩 방식 slug)와 같은 제목 접미사는 문서마다 새로', () => {
  const { div } = html('## D-1. 저장소 상태\n\n## 결론\n\n## 결론\n');
  assert.deepEqual(q(div, 'h2').map((h) => h.id), ['d-1-저장소-상태', '결론', '결론-1']);
  assert.deepEqual(q(html('## 결론\n').div, 'h2').map((h) => h.id), ['결론']);
});

test('<details> 안의 표와 mermaid 표지', () => {
  const { div } = html('<details>\n<summary>s</summary>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n</details>\n\n```mermaid\nflowchart LR\n  a-->b\n```\n');
  assert.equal(q(div, 'details table').length, 1);
  const m = q(div, 'pre.mermaid');
  assert.equal(m.length, 1);
  assert.match(m[0].textContent, /a-->b/);
});

test('링크 변환: 기록·이슈·호스트, 같은 문서 앵커와 코드 안은 그대로', () => {
  const md = '[r](proposal.md#s-1) [t](../../../board/tasks/APP-1.md) [w](../../../bin/x.mjs) [repo](../../../../ws/app/a.java) [s](#결론) `[c](../../../bin/y.mjs)`\n\n[ref][1]\n\n[1]: ../CMN-2/x.md\n\n<a href="../../../bin/z.mjs">raw</a>\n';
  const { div } = html(md);
  const hrefs = Object.fromEntries(q(div, 'a').map((a) => [a.textContent, a.getAttribute('href')]));
  assert.equal(hrefs.r, '#R=records/common/CMN-8/proposal.md~s-1');
  assert.equal(hrefs.t, '#APP-1');
  assert.equal(hrefs.w, 'https://git.example/grp/wb/-/blob/c0ffee1234/bin/x.mjs');
  assert.equal(hrefs.repo, 'https://git.example/grp/app/-/blob/HEAD/a.java');
  assert.equal(hrefs.s, '#결론');
  assert.equal(hrefs.ref, '#R=records/common/CMN-2/x.md');
  assert.equal(hrefs.raw, 'https://git.example/grp/wb/-/blob/c0ffee1234/bin/z.mjs');
  assert.match(div.querySelector('code').textContent, /\.\.\/\.\.\/\.\.\/bin\/y\.mjs/);
  const ext = q(div, 'a').find((a) => a.textContent === 'w');
  assert.equal(ext.getAttribute('target'), '_blank');
  assert.equal(ext.getAttribute('rel'), 'noopener noreferrer');
});

test('기록 프론트매터 base로 저장소 링크 커밋을 정하고, 풀 수 없는 링크는 경고', () => {
  const md = '---\ntitle: T\nrepos: [app]\nbase: main@137bffe2\n---\n\n[a](../../../../ws/app/a.java) [b](../../../../other/nope/x.md)\n';
  const { div, warnings, data } = html(md, { frontmatter: true });
  assert.equal(data.title, 'T');
  assert.equal(q(div, 'a')[0].getAttribute('href'), 'https://git.example/grp/app/-/blob/137bffe2/a.java');
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(div.textContent, /title: T/);
});

test('이미지는 src를 비우고 workbench 경로만 남긴다(한글 파일명)', () => {
  const { div } = html('![그림](design/Fig1-1_%ED%98%84%ED%96%89.png)\n');
  const img = div.querySelector('img');
  assert.equal(img.getAttribute('src'), null);
  assert.equal(img.getAttribute('data-wb-src'), 'records/common/CMN-8/design/Fig1-1_현행.png');
});

test('정화: 스크립트·이벤트·javascript:·form·style·앱 id 덮어쓰기를 지운다', () => {
  const md = '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n\n[x](javascript:alert(3))\n\n<form action="https://evil"><button>b</button></form>\n\n<style>body{display:none}</style>\n\n<p style="position:fixed" id="wb-board" name="wb-x">p</p>\n\n<input type="text" value="t">\n';
  const { div } = html(md);
  const out = div.innerHTML;
  assert.doesNotMatch(out, /onerror|<script|href="javascript|<form|<style|style=|wb-board|wb-x|type="text"/);
  assert.equal(div.querySelectorAll('a').length, 0); // javascript: 링크는 링크가 되지 않고 글자로 남는다
});
