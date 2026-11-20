// 규칙 정합성: 같은 형식 사실이 코드·검사기·수정 안내·문서 예시에서 갈라지지 않는지 본다 (CLAUDE.md "규칙의 정본")
//   C-1 제목 문법은 plugin/cli/lib/model/markdown.mjs 한 곳에만 있다
//   C-3 lint의 기계적 수정(edits)을 적용하면 그 위반이 사라지고 새 위반이 생기지 않는다
//   C-4 플러그인 문서의 형식 예시(wb-example 블록)와 인라인 링크 예시, 문서끼리의 앵커 링크가 규칙을 통과한다
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, cli } from './fixture.mjs';
import { anchorsOf, blankCode } from '../plugin/cli/lib/model/markdown.mjs';
import { collectLinks } from '../plugin/cli/lib/lint-rules.mjs';
import { FORMAT_VERSION } from '../plugin/cli/lib/shared-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugin');
const GRAMMAR = path.join(PLUGIN, 'cli', 'lib', 'model', 'markdown.mjs');
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const pluginDocs = () => walk(PLUGIN).filter((f) => f.endsWith('.md'));
const relRoot = (f) => path.relative(ROOT, f).split(path.sep).join('/');

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

const lintAll = () => cli(fx, 'lint', ['--all'], { json: true }).json;
const key = (f) => `${f.rule}|${f.file}|${f.line ?? ''}|${f.message}`;
const useFormatVersion = (v) => fx.write('workbench.config.json', `${JSON.stringify({ formatVersion: v })}\n`);
const link = (file, kind) => {
  const r = cli(fx, 'link-output', ['--task', 'KEYA-1', '--kind', kind, '--path', file, '--desc', '시험']);
  assert.equal(r.code, 0, r.out + r.err);
};
const recordFm = (title) => `---\ntitle: ${title}\nlifecycle: record\ntask_id: KEYA-1\nrepos: []\nbase: none\nupdated: 2026-11-20\n---\n\n`;

/** edits를 문서 저장소 파일에 적용한다. before가 그 줄과 다르면 실패 */
function applyEdits(edits) {
  for (const e of edits) {
    const lines = fx.read(e.file).split('\n');
    assert.equal(lines[e.line - 1], e.before, `${e.file}:${e.line}의 before가 지금 줄과 다르다`);
    lines[e.line - 1] = e.after;
    fx.write(e.file, lines.join('\n'));
  }
}

// ── C-1 ─────────────────────────────────────────────────

test('C-1: 제목 정규식은 문법 모듈(model/markdown.mjs)에만 있다', () => {
  // `/^#` 다음에 #·공백·{·+가 오거나, 들여쓰기 허용(`/^ {0,3}#`)으로 시작하는 정규식 리터럴. URL 해시(`/^#([A-Z]…`)는 대상이 아니다
  const HEADING_REGEX = /\/\^(?: \{0,3\}|\\s\*| \*)?#(?:[#{ +]|\\s)/;
  const sources = [path.join(PLUGIN, 'cli'), path.join(PLUGIN, 'hooks'), path.join(ROOT, 'site', 'src')]
    .flatMap(walk).filter((f) => /\.(mjs|js)$/.test(f) && f !== GRAMMAR);
  const bad = [];
  for (const f of sources) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (HEADING_REGEX.test(l)) bad.push(`${relRoot(f)}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(bad, [], '제목은 plugin/cli/lib/model/markdown.mjs의 parseHeading·anchorsOf·firstH1로 읽는다');
  // 검사식이 실제로 잡는지
  for (const s of ['/^### (D-\\d+)\\b/', '/^## (.+)$/', '/^#{1,6}\\s/', '/^ {0,3}#{1,6}/']) assert.ok(HEADING_REGEX.test(s), s);
  assert.ok(!HEADING_REGEX.test('/^#([A-Z][A-Z0-9]*-\\d+)/'));
});

// ── C-3 ─────────────────────────────────────────────────

/**
 * edits가 나오는 위반 장면. 장면마다 새 작업 공간에 만든다.
 * WBENGINE-2: decisions.md 상세 절을 slug로 가리키면 LINK-ANCHOR-ID가 제목 안 앵커를 안내하고, 그대로 고치면 DEC-FORMAT·decision-stats도 통과해야 한다
 */
const SCENES = {
  'decisions.md 상세 절을 slug로 링크(앵커 없음)': () => {
    fx.write('records/alpha/KEYA-1/decisions.md', `${recordFm('A 결정 기록')}# A 결정 기록\n\n평가 상태: 평가 전\n진행: \n\n## 요약\n\n`
      + '| D | 단계 | 결정할 것 | 채택안 | 영향도 | 평가 | 하네스 |\n|---|---|---|---|---|---|---|\n'
      + '| D-1 | design | 범위를 넓히는가 | 넓힌다 | 상 |  | 1.6.0 |\n| D-2 | design | 기간을 바꾸는가 | 바꾼다 | 중 |  | 1.6.0 |\n\n## 상세\n\n'
      + '### D-1 범위를 넓히는가\n\n- 영향: 업무 규칙·정책\n\n<a id="D-2"></a>\n### D-2 기간을 바꾸는가\n\n- 영향: 업무 규칙·정책\n');
    fx.write('records/alpha/KEYA-1/design.md', `${recordFm('A 설계')}# A 설계\n\n`
      + '- 범위를 넓힌다([D-1](decisions.md#d-1-범위를-넓히는가)).\n- 기간을 바꾼다([D-2](decisions.md#d-2-기간을-바꾸는가)).\n');
    link('records/alpha/KEYA-1/decisions.md', '결정');
    link('records/alpha/KEYA-1/design.md', '설계');
  },
  '같은 문서의 ID 제목을 slug로 링크(제목 안 앵커 있음·없음)': () => {
    fx.write('records/alpha/KEYA-1/plan.md', `${recordFm('A 계획')}# A 계획\n\n`
      + '## ST-1 저장소를 고친다\n\n## <a id="ST-2"></a>ST-2 시험을 더한다\n\n순서: [ST-1](#st-1-저장소를-고친다) → [ST-2](#st-2-시험을-더한다)\n');
    link('records/alpha/KEYA-1/plan.md', '작업계획');
  },
};

for (const [name, setup] of Object.entries(SCENES)) {
  test(`C-3: 수정(edits)을 적용하면 그 위반만 사라진다 — ${name}`, () => {
    useFormatVersion(FORMAT_VERSION);
    setup();
    const before = lintAll().findings;
    const fixable = before.filter((f) => f.edits);
    assert.ok(fixable.length > 0, '이 장면은 edits가 있는 위반을 내야 한다');
    const snapshot = new Map(walk(fx.wb).filter((f) => !f.includes(`${path.sep}.git${path.sep}`)).map((f) => [f, fs.readFileSync(f)]));
    for (const f of fixable) {
      for (const [p, buf] of snapshot) fs.writeFileSync(p, buf); // 위반마다 따로 적용한다
      applyEdits(f.edits);
      const after = lintAll().findings;
      const beforeKeys = new Set(before.map(key));
      const added = after.filter((x) => !beforeKeys.has(key(x)));
      assert.deepEqual(added.map(key), [], `${key(f)}의 edits가 새 위반을 만들었다`);
      assert.ok(!after.some((x) => key(x) === key(f)), `${key(f)}가 edits 적용 뒤에도 남았다`);
      const stats = cli(fx, 'decision-stats', ['--check']);
      if (fx.exists('records/alpha/KEYA-1/decisions.md')) assert.equal(stats.code, 0, stats.out);
    }
  });
}

test('C-3: decisions.md 상세 절은 정식(제목 안 앵커)·옛 형식(앵커 없음, 제목 위 줄 앵커)을 모두 같은 항목으로 읽는다', () => {
  useFormatVersion(FORMAT_VERSION);
  SCENES['decisions.md 상세 절을 slug로 링크(앵커 없음)']();
  const text = fx.read('records/alpha/KEYA-1/decisions.md').replace('### D-1 범위를', '### <a id="D-1"></a>D-1 범위를');
  fx.write('records/alpha/KEYA-1/decisions.md', text);
  fx.write('records/alpha/KEYA-1/design.md', fx.read('records/alpha/KEYA-1/design.md').replace(/#d-\d-[^)]*/g, (m) => `#D-${m[3]}`));
  const r = lintAll();
  assert.deepEqual(r.findings.filter((f) => /^(DEC|LINK)-/.test(f.rule)).map(key), []);
  assert.equal(cli(fx, 'decision-stats', ['--check']).code, 0);
});

// ── C-2 (검사기 통합) ───────────────────────────────────

test('DEC-FORMAT·DEC-LINK: lint가 decisions.md 형식을 검사한다. 형식 버전 2부터 오류, 그 전에는 경고', () => {
  SCENES['decisions.md 상세 절을 slug로 링크(앵커 없음)']();
  fx.write('records/alpha/KEYA-1/decisions.md', fx.read('records/alpha/KEYA-1/decisions.md').replace('### D-1 범위를 넓히는가', '### D-9 범위를 넓히는가'));
  fx.write('records/alpha/KEYA-1/design.md', `${fx.read('records/alpha/KEYA-1/design.md')}- 없는 결정([D-7](decisions.md#D-7)).\n`);
  const pick = (r) => r.findings.filter((f) => f.rule.startsWith('DEC-')).map((f) => [f.rule, f.severity, f.file, f.message]).sort();
  const expected = (severity) => [
    ['DEC-FORMAT', severity, 'records/alpha/KEYA-1/decisions.md', 'D-1의 상세 절(\'### <a id="D-1"></a>D-1 …\')이 없다'],
    ['DEC-FORMAT', severity, 'records/alpha/KEYA-1/decisions.md', '상세 절 D-9가 요약 표에 없다'],
    ['DEC-LINK', severity, 'records/alpha/KEYA-1/design.md', '링크한 D-7가 decisions.md 요약 표에 없다'],
  ];
  assert.deepEqual(pick(lintAll()), expected('warn'));
  useFormatVersion(2);
  const r = cli(fx, 'lint', ['--files', 'records/alpha/KEYA-1/decisions.md'], { json: true });
  assert.equal(r.code, 1);
  assert.deepEqual(pick(r.json), expected('error'), 'decisions.md만 대상이어도 그것을 링크한 산출물의 DEC-LINK를 보인다');
  // decision-stats --check는 같은 검사다
  const check = cli(fx, 'decision-stats', ['--check', '--task', 'KEYA-1'], { json: true });
  assert.deepEqual(check.json.errors.map((e) => e.message).sort(), expected('').map((x) => x[3]).sort());
});

// ── C-4 ─────────────────────────────────────────────────

/** 플러그인 문서의 ```<lang> wb-example="<파일명>" 블록 */
function examples() {
  const out = [];
  for (const f of pluginDocs()) {
    const lines = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(`{3,}|~{3,})\S*\s+wb-example="([^"]+)"\s*$/.exec(lines[i]);
      if (!m) continue;
      const end = lines.findIndex((l, j) => j > i && l.startsWith(m[1]) && l.trim() === m[1]);
      assert.ok(end > i, `${relRoot(f)}:${i + 1} 예시 블록이 닫히지 않았다`);
      out.push({ from: `${relRoot(f)}:${i + 1}`, name: m[2], text: `${lines.slice(i + 1, end).join('\n')}\n` });
      i = end;
    }
  }
  return out;
}

test('C-4: 플러그인 문서의 형식 예시(wb-example)는 lint를 통과한다', () => {
  const list = examples();
  assert.ok(list.some((e) => e.name === 'decisions.md'), 'decisions-format.md의 구조 예시가 wb-example이어야 한다');
  useFormatVersion(FORMAT_VERSION);
  for (const e of list) {
    const file = `records/alpha/KEYA-1/${e.name}`;
    fx.write(file, e.text.startsWith('---\n') ? e.text : `${recordFm('예시')}${e.text}`);
    link(file, e.name === 'decisions.md' ? '결정' : '설계');
    const r = cli(fx, 'lint', ['--files', file], { json: true }).json;
    // 예시가 가리키는 다른 산출물(proposal.md 등)은 예시 밖이라 없다
    const left = r.findings.filter((f) => f.rule !== 'LINK-BROKEN').map((f) => `${f.rule} ${f.file}:${f.line} ${f.message}`);
    assert.deepEqual(left, [], `${e.from}의 예시가 규칙을 어긴다`);
    fs.rmSync(path.join(fx.wb, file));
  }
});

test('C-4: 플러그인 문서의 인라인 링크 예시는 ID 항목을 제목 slug로 가리키지 않는다', () => {
  const bad = [];
  for (const f of pluginDocs()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const code of text.matchAll(/`([^`\n]*\]\([^)`]*\.md#[^)`]*\)[^`\n]*)`/g)) {
      for (const m of code[1].matchAll(/\]\([^)#]*\.md#([^)]*)\)/g)) {
        // `#d-2-…`, `#st-1-…`, `#d-n-…`: ID 항목 제목(`D-2 …`)의 slug. ID 앵커(`#D-2`)로 쓴다
        if (/^[a-z][a-z0-9]{0,3}-(?:\d+|n)(?:-|…|$)/.test(m[1])) bad.push(`${relRoot(f)}: ${code[0]}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('C-4: 플러그인 문서끼리의 앵커 링크는 대상 문서에 있다', () => {
  const bad = [];
  const anchorsCache = new Map();
  const anchorsAt = (f) => anchorsCache.get(f) ?? anchorsCache.set(f, anchorsOf(fs.readFileSync(f, 'utf8')).ids).get(f);
  for (const f of pluginDocs()) {
    for (const { href, line } of collectLinks(fs.readFileSync(f, 'utf8'))) {
      const hashAt = href.indexOf('#');
      if (hashAt < 0 || /^(https?|mailto):/i.test(href)) continue;
      const filePart = href.slice(0, hashAt);
      const target = !filePart ? f
        : filePart.startsWith('${CLAUDE_PLUGIN_ROOT}/') ? path.join(PLUGIN, filePart.slice('${CLAUDE_PLUGIN_ROOT}/'.length))
          : path.resolve(path.dirname(f), decodeURIComponent(filePart));
      if (!target.endsWith('.md') || !fs.existsSync(target)) continue; // 파일 존재는 plugin.test.mjs가 본다
      let anchor = href.slice(hashAt + 1);
      try { anchor = decodeURIComponent(anchor); } catch { /* 그대로 */ }
      if (!anchorsAt(target).has(anchor)) bad.push(`${relRoot(f)}:${line} ${href}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('blankCode: 코드 블록과 인라인 코드를 같은 길이 공백으로 지우고 줄 번호를 지킨다', () => {
  const src = 'a `[x](y.md)` b\r\n```\n[z](w.md)\n```\nc\n';
  const out = blankCode(src);
  assert.equal(out.split('\n').length, src.replace(/\r\n/g, '\n').split('\n').length);
  assert.ok(!out.includes('y.md') && !out.includes('w.md'));
});
