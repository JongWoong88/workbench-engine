// 기록·이슈 본문 렌더러. markdown-it(CommonMark + 표) → DOMPurify 정화 → 링크·이미지 변환.
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import taskLists from '@hackmd/markdown-it-task-lists';
import GithubSlugger from 'github-slugger';
import createDOMPurify from 'dompurify';
import { parseTaskText } from '../../plugin/cli/lib/model/board.mjs';
import { resolveHref, parseBase } from './links.mjs';

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 앱이 쓰는 요소 id의 접두. 본문이 이 id를 만들지 못하게 지운다(DOM clobbering 방지) */
export const APP_ID_PREFIX = 'wb-';

/**
 * @param {Window} window  DOMPurify와 DOM 조작에 쓰는 창(브라우저는 window, 시험은 jsdom)
 * @returns {(markdown: string, opts: RenderOptions) => { fragment: DocumentFragment, data: object, warnings: string[] }}
 *
 * RenderOptions:
 *  - srcRel: workbench 기준 원본 경로(링크 해석 기준)
 *  - ctx: { server, project, commit, projects }
 *  - route: { record(path, anchor) → href, task(id) → href } — 보드 안 이동 주소
 *  - frontmatter: true면 프론트매터를 떼고 base로 저장소 링크 커밋을 정한다(기록 문서)
 */
export function createRenderer(window) {
  const purify = createDOMPurify(window);
  purify.addHook('uponSanitizeElement', (node, data) => {
    // 작업 목록 체크박스만 남긴다
    if (data.tagName === 'input' && !(node.getAttribute('type') === 'checkbox')) node.parentNode?.removeChild(node);
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'INPUT') node.setAttribute('disabled', '');
    for (const attr of ['id', 'name']) if (node.getAttribute(attr)?.startsWith(APP_ID_PREFIX)) node.removeAttribute(attr);
  });

  return function render(markdown, { srcRel, ctx, route, frontmatter = false }) {
    let body = markdown;
    let data = {};
    if (frontmatter) {
      const t = parseTaskText(markdown);
      if (!t.error) ({ body, data } = t);
    }
    const slugger = new GithubSlugger(); // 문서마다 새로 — 같은 제목의 -1 접미사가 문서 사이에서 새지 않게
    const md = new MarkdownIt({ html: true, linkify: false })
      .use(anchor, { slugify: (s) => slugger.slug(s), tabIndex: false })
      .use(taskLists, { enabled: false });
    const fence = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const info = tokens[idx].info.trim().split(/\s+/)[0];
      if (info === 'mermaid') return `<pre class="mermaid">${md.utils.escapeHtml(tokens[idx].content)}</pre>\n`;
      return fence(tokens, idx, options, env, self);
    };

    const fragment = purify.sanitize(md.render(body), {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['style', 'form'],
      FORBID_ATTR: ['style'],
    });

    const warnings = [];
    const shas = frontmatter ? parseBase(data.base, data.repos, ctx.projects) : {};
    for (const a of fragment.querySelectorAll('a[href]')) {
      const r = resolveHref(a.getAttribute('href'), srcRel, ctx, shas);
      if (r.kind === 'record') a.setAttribute('href', route.record(r.path, r.anchor));
      else if (r.kind === 'task') a.setAttribute('href', route.task(r.id));
      else if (r.kind === 'host' && r.url) a.setAttribute('href', r.url);
      else if (r.kind === 'host') a.removeAttribute('href'); // 호스트 설정이 없으면 링크 없이 글자만 둔다
      else if (r.kind === 'unresolved') warnings.push(r.warning);
      else if (a.getAttribute('href').startsWith('#')) a.setAttribute('href', `#${decode(a.getAttribute('href').slice(1))}`); // 제목 id와 같은 형태로
      const href = a.getAttribute('href');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('mailto:')) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      }
    }
    // 이미지는 문서 저장소 안의 파일만 보드 API로 받아 채운다. 경로만 남기고 화면이 받는다
    for (const img of fragment.querySelectorAll('img[src]')) {
      const r = resolveHref(img.getAttribute('src'), srcRel, ctx, shas);
      img.removeAttribute('src');
      if (r.kind === 'host' && r.path) img.setAttribute('data-wb-src', r.path);
      else if (r.kind === 'unresolved') warnings.push(r.warning);
    }
    return { fragment, data, warnings };
  };
}
