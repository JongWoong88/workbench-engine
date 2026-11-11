// bin/lib/anchors.mjs: lint가 계산한 앵커가 보드 사이트 렌더러(markdown-it-anchor + github-slugger)와 같은지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import GithubSlugger from 'github-slugger';
import { anchorsOf, headingItemId } from '../plugin/cli/lib/anchors.mjs';

const WB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 사이트와 같은 설정으로 렌더링해 제목 id를 순서대로 */
function siteHeadingIds(markdown) {
  const slugger = new GithubSlugger();
  const md = new MarkdownIt({ html: true, linkify: false }).use(anchor, { slugify: (s) => slugger.slug(s), tabIndex: false });
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return [...md.render(body).matchAll(/<h[1-6] id="([^"]+)"/g)].map((m) => m[1]);
}

const sample = [
  '# 제목',
  '## 2.1 gate와 결정 요청',
  '### Phase 0 — 기준선, golden set, seeded set',
  '### <a id="ST-1"></a>ST-1 오케스트레이터 실행 구조',
  '### D-18 되돌릴 때 pet_info 선택 코드를 비우는가',
  '## 공통 컬럼(prod_ 테이블)',
  '## `<details>` 계층적 노출과 **강조**, [링크](x.md), ①②',
  '## 제목',
  '## 제목',
  '```',
  '## 코드 블록 안은 제목이 아니다 <a id="NOPE"></a>',
  '```',
  '| <a id="O-12"></a>O-12 | 내용 `<a id="CODE"></a>` |',
].join('\n');

test('제목 slug가 사이트 렌더러와 같다 — 예시', () => {
  const { headings } = anchorsOf(sample);
  assert.deepEqual([...headings.keys()], siteHeadingIds(sample));
});

test('명시 앵커: 본문 HTML의 id는 앵커, 코드 안은 아니다. 제목 안 id는 그 제목에 묶인다', () => {
  const { ids, headings } = anchorsOf(sample);
  assert.ok(ids.has('O-12'));
  assert.ok(ids.has('ST-1'));
  assert.ok(!ids.has('NOPE'));
  assert.ok(!ids.has('CODE'));
  assert.deepEqual(headings.get('st-1-오케스트레이터-실행-구조').explicit, ['ST-1']);
});

test('제목 slug가 사이트 렌더러와 같다 — 저장소의 모든 기록·이슈·플러그인 문서', () => {
  const files = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md')) files.push(p);
    }
  };
  ['records', 'board/tasks', 'plugin'].forEach((d) => walk(path.join(WB, d)));
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.deepEqual([...anchorsOf(text).headings.keys()], siteHeadingIds(text), path.relative(WB, f));
  }
});

test('headingItemId: 제목 맨 앞의 ID만 본다', () => {
  assert.equal(headingItemId('ST-1 오케스트레이터'), 'ST-1');
  assert.equal(headingItemId('D-30 작업 브랜치'), 'D-30');
  assert.equal(headingItemId('L1 판정 방향 반전'), 'L1');
  assert.equal(headingItemId('6. ST-1 확인 결과'), null);
  assert.equal(headingItemId('Phase 0 — 기준선'), null);
  assert.equal(headingItemId('FN 대책'), null);
});
