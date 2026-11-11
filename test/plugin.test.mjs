// 플러그인은 설치물 안에서만 자기 파일을 찾는다: 스킬·규칙은 플러그인 상위 폴더를 가리키지 않고,
// 세션 안내 훅은 PC별 설정으로 문서 저장소를 찾는다
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace } from './fixture.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('스킬·규칙·에이전트는 플러그인 밖 파일을 가리키지 않는다', () => {
  const bad = [];
  for (const f of walk(PLUGIN).filter((x) => /\.(md|json)$/.test(x))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/\.\.|workbench clone/g)) bad.push(`${path.relative(PLUGIN, f)}: ${m[0]}`);
    // 상대 링크는 풀어서 플러그인 폴더 안인지 본다(설치물에는 플러그인 폴더만 있다). 코드 안의 예시는 링크가 아니다
    const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of prose.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|\$\{)/.test(href)) continue;
      const target = path.resolve(path.dirname(f), decodeURIComponent(href));
      if (!target.startsWith(PLUGIN + path.sep)) bad.push(`${path.relative(PLUGIN, f)}: ${href}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('스킬·규칙이 가리키는 플러그인 안 문서가 있다', () => {
  const missing = [];
  for (const f of walk(PLUGIN).filter((x) => x.endsWith('.md'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^)\s`]+)/g)) {
      if (!fs.existsSync(path.join(PLUGIN, m[1].split('#')[0]))) missing.push(`${path.relative(PLUGIN, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

const hook = (env) => {
  const e = { ...process.env, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), ...env };
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', 'session-context.mjs')], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('세션 안내: PC별 설정의 문서 저장소와 그 task_id 접두사, 플러그인 안 규칙 문서를 알린다', () => {
  fs.mkdirSync(path.join(fx.ws, '.wb-config'));
  fs.writeFileSync(path.join(fx.ws, '.wb-config', 'config.json'), JSON.stringify({ dataRoot: fx.wb }));
  const out = hook({ WORKBENCH_ROOT: undefined });
  assert.ok(out.includes(`문서 저장소(작업 보드 이슈`), out);
  assert.ok(out.includes(fx.wb.split(path.sep).join('/')), out);
  assert.match(out, /접두사는 `KEYA`, `KEYB`, `KEYC`다/);
  assert.match(out, /references\/workbench-rules\.md/);
  assert.match(out, /references\/workbench-format\.md/);
});

test('세션 안내: 문서 저장소가 정해지지 않았으면 설정 방법을 알린다', () => {
  const out = hook({ WORKBENCH_ROOT: undefined });
  assert.match(out, /wb config set data-root/);
  assert.doesNotMatch(out, /접두사는/);
});

test('세션 안내: 환경변수 WORKBENCH_ROOT가 설정보다 우선한다', () => {
  assert.ok(hook({ WORKBENCH_ROOT: fx.wb }).includes(fx.wb.split(path.sep).join('/')));
});
