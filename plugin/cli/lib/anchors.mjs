// 마크다운 문서가 만드는 앵커(id)를 모은다. lint의 LINK-ANCHOR·LINK-ANCHOR-ID가 쓴다.
//   - 제목: 보드 화면 렌더러(site/src/render.mjs: markdown-it-anchor + github-slugger)와 같은 slug를 만든다.
//     github-slugger는 사이트 빌드용 devDependency라 `npm ci --omit=dev` 환경에서도 돌도록 같은 규칙을 여기 둔다.
//     test/anchors.test.mjs가 실제 렌더러 결과와 대조한다.
//   - 명시 앵커: 본문 HTML의 id·name 속성(<a id="O-12"></a> 등). 코드 블록·인라인 코드 안은 앵커가 아니다.

/** github-slugger 2.x와 같은 규칙: 소문자로 바꾸고, 글자·10진 숫자·글자 숫자·결합 문자·`_`·`-`·공백 밖의 문자(①, ² 등 포함)를 지우고, 공백을 `-`로 */
export function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

/** 문서 안 slug 중복에 -1, -2를 붙인다 (github-slugger의 occurrences와 같다) */
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text);
    let slug = base;
    while (seen.has(slug)) {
      const n = seen.get(base) + 1;
      seen.set(base, n);
      slug = `${base}-${n}`;
    }
    seen.set(slug, 0);
    return slug;
  };
}

/**
 * markdown-it-anchor는 제목의 text·code_inline 토큰만 이어 붙여 slug를 만든다.
 * 인라인 HTML·이미지는 빠지고, 링크·강조는 글자만 남는다.
 */
function headingText(raw) {
  const codes = [];
  return raw
    .replace(/`([^`]*)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`) // 인라인 코드는 내용 그대로 (아래 치환에서 보호)
    .replace(/<[^>]+>/g, '') // 인라인 HTML
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 이미지
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 링크 → 글자
    .replace(/(\*{1,3}|~~)/g, '') // 강조
    .replace(/(^|[^\p{L}\p{N}])_{1,3}([^_]+?)_{1,3}(?=$|[^\p{L}\p{N}])/gu, '$1$2') // _강조_ (pet_info·prod_ 같은 _는 남긴다)
    .replace(/\\(.)/g, '$1') // 이스케이프
    .replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i])
    .trim();
}

const ATTR_ID_RE = /<[a-z][^>]*?\s(?:id|name)\s*=\s*["']([^"']+)["']/gi;
/** 코드 블록·인라인 코드를 같은 길이의 공백으로 지운다 (줄 번호 유지) */
const stripFences = (text) => text.replace(/^(```|~~~)[\s\S]*?^\1/gm, (m) => m.replace(/[^\n]/g, ' '));
const stripInlineCode = (text) => text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

/**
 * @returns {{ ids: Set<string>, headings: Map<string, {line: number, explicit: string[], text: string}> }}
 *   ids: 링크로 갈 수 있는 모든 앵커(제목 slug + 명시 앵커). headings: 제목 slug → 그 제목 정보
 */
export function anchorsOf(markdown) {
  const text = stripFences(markdown.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, (m) => m.replace(/[^\n]/g, ' ')));
  const ids = new Set();
  const headings = new Map();
  const slug = slugger();
  text.split('\n').forEach((line, i) => {
    const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (!m) return;
    const explicit = [...stripInlineCode(m[1]).matchAll(ATTR_ID_RE)].map((a) => a[1]);
    const s = slug(headingText(m[1]));
    ids.add(s);
    headings.set(s, { line: i + 1, explicit, text: headingText(m[1]) });
  });
  for (const a of stripInlineCode(text).matchAll(ATTR_ID_RE)) ids.add(a[1]);
  return { ids, headings };
}

/** 제목이 ID 항목(`ST-1 …`, `D-5 …`, `O-12 …`, `L1 …`)이면 그 ID */
export function headingItemId(headingTextValue) {
  return /^([A-Z][A-Z0-9]*-\d+[a-z]?|[A-Z]\d+)(?=\s|$)/.exec(headingTextValue)?.[1] ?? null;
}
