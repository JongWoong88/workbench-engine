#!/usr/bin/env node
// 보드 화면 묶음을 만든다. 기본 출력은 plugin/board-ui/ — 설치물에 들어가고, wb board가 서빙한다.
// 산출물: index.html, app.css, app.js(site/src/main.mjs 묶음), vendor/(mermaid, 코드 강조). 보드·기록 데이터는 넣지 않는다 —
// 화면이 같은 출처의 보드 API로 읽는다. --dev면 site/를 고칠 때마다 다시 묶는다(보드는 wb board로 따로 띄운다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, args, Rejection, EXIT } from '../plugin/cli/lib/report.mjs';
import { posix } from '../plugin/cli/lib/workbench.mjs';

// 엔진 저장소 루트(이 파일의 상위 폴더). 보드 화면 원본 site/와 빌드 도구 node_modules/가 여기 있다
const WB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (abs) => posix(path.relative(WB, abs));

const USAGE = `사용법: node bin/build-site.mjs [--dev] [--out <폴더>]
  --dev   site/를 고치면 다시 묶는다(끝내려면 Ctrl+C). 보드는 다른 터미널에서 wb board로 띄운다
  --out   산출 폴더 (기본 plugin/board-ui)`;

const SITE = path.join(WB, 'site');
const NM = path.join(WB, 'node_modules');
const STATIC = ['index.html', 'app.css'];
const VENDOR = [
  [path.join(NM, 'mermaid', 'dist', 'mermaid.min.js'), 'vendor/mermaid.min.js'],
  [path.join(NM, 'highlight.js', 'styles', 'github.min.css'), 'vendor/hljs-light.css'],
  [path.join(NM, 'highlight.js', 'styles', 'github-dark.min.css'), 'vendor/hljs-dark.css'],
];

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    throw new Rejection({ code: 'ENV-ESBUILD', message: 'esbuild가 설치되어 있지 않다', fix: '엔진 저장소에서 `npm ci`를 실행한다', exit: EXIT.ENV });
  }
}

function copyStatic(out) {
  for (const name of STATIC) fs.copyFileSync(path.join(SITE, name), path.join(out, name));
  fs.mkdirSync(path.join(out, 'vendor'), { recursive: true });
  for (const [from, to] of VENDOR) fs.copyFileSync(from, path.join(out, to));
}

const entries = (out, dev) => [
  { entryPoints: [path.join(SITE, 'src', 'main.mjs')], outfile: path.join(out, 'app.js') },
  { entryPoints: [path.join(SITE, 'src', 'hljs.mjs')], outfile: path.join(out, 'vendor', 'hljs.js') },
].map((e) => ({ ...e, bundle: true, format: 'iife', target: 'es2022', minify: !dev, sourcemap: dev, logLevel: 'warning', legalComments: 'none' }));

run(async () => {
  const { values } = args({ dev: { type: 'boolean' }, out: { type: 'string' } }, USAGE);
  const out = path.resolve(WB, values.out ?? path.join('plugin', 'board-ui'));
  const esbuild = await loadEsbuild();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  copyStatic(out);

  if (!values.dev) {
    for (const e of entries(out, false)) await esbuild.build(e);
    const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
    const size = (f) => `${(fs.statSync(path.join(out, f)).size / 1024).toFixed(0)}KB`;
    return {
      data: { out: rel(out), files },
      text: [`만듦: ${rel(out)}/`, ...files.map((f) => `  ${f.split(path.sep).join('/')} ${size(f)}`)].join('\n'),
    };
  }

  const [main, ...rest] = entries(out, true);
  for (const e of rest) await esbuild.build(e);
  const ctx = await esbuild.context(main);
  await ctx.watch();
  fs.watch(SITE, (_, name) => { if (STATIC.includes(name)) copyStatic(out); });
  console.log(`보드 화면: ${rel(out)}/ 를 다시 묶는 중. 다른 터미널에서 wb board로 띄운다 (Ctrl+C로 끝낸다)`);
  await new Promise(() => {});
}, USAGE, { needsData: false });
