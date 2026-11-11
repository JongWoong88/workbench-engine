#!/usr/bin/env node
// 게시 패키지(플러그인이자 npm 패키지)를 dist/package/에 만든다. 엔진 CI가 이것을 npm에 게시한다.
//   - CLI는 bin/wb.mjs 한 파일로 묶는다. Node 내장 모듈 밖의 import가 남으면 거부한다(호환 규칙 K-6)
//   - plugin.json과 package.json의 version이 같아야 한다(K-9)
//   - 패키지의 bin은 wb 하나다. 문서 저장소 CI가 `npx -y <패키지>@^1 lint --all`로 부르는 전제다(K-7)
//   - 패키지 밖 파일을 참조하지 않는다. 설치 폴더에 상태를 쓰지 않는다(설치물 규칙)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run, args, Rejection, EXIT } from '../plugin/cli/lib/report.mjs';
import { posix } from '../plugin/cli/lib/workbench.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugin');
const rel = (abs) => posix(path.relative(ROOT, abs));

// 공개 이름. 마켓플레이스(.claude-plugin/marketplace.json)와 문서 저장소 CI 템플릿(plugin/templates/ci)도 같은 이름을 쓴다
export const PACKAGE = {
  name: '@fiveeyes/workbench-engine',
  author: 'fiveeyes',
  repository: 'https://github.com/JongWoong88/workbench-engine',
};
/** 패키지에 그대로 복사하는 플러그인 폴더·파일. cli/는 bin/wb.mjs로 묶으므로 넣지 않는다 */
const COPY = ['.claude-plugin', 'agents', 'hooks', 'references', 'skills', 'templates', 'board.yml', 'README.md', 'bin/wb', 'bin/wb.cmd'];

const USAGE = `사용법: node bin/build-package.mjs [--out <폴더>]
  --out   산출 폴더 (기본 dist/package)
  결과 폴더를 그대로 npm publish 하거나 claude --plugin-dir로 올려 확인한다`;

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    throw new Rejection({ code: 'ENV-ESBUILD', message: 'esbuild가 설치되어 있지 않다', fix: '엔진 저장소에서 `npm ci`를 실행한다', exit: EXIT.ENV });
  }
}

/** esbuild metafile의 입력에서 묶인 npm 패키지 이름들 */
function bundledPackages(meta) {
  const names = new Set();
  for (const input of Object.keys(meta.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join('/'));
    if (m) names.add(m[1]);
  }
  return names;
}

/** 묶은 외부 라이브러리의 라이선스 고지 */
function notices(names) {
  const out = ['# 외부 라이브러리 고지', '', '이 패키지의 bin/wb.mjs와 board-ui/는 아래 라이브러리를 포함한다.', ''];
  for (const name of [...names].sort()) {
    const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
    const pkg = readJson(path.join(dir, 'package.json'));
    const file = fs.readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
    out.push(`## ${name} ${pkg.version}`, '', `License: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? null)}`, '');
    if (file) out.push('```', fs.readFileSync(path.join(dir, file), 'utf8').trim(), '```', '');
  }
  return out.join('\n');
}

run(async () => {
  const { values } = args({ out: { type: 'string' } }, USAGE, { positionals: false });
  const out = path.resolve(ROOT, values.out ?? path.join('dist', 'package'));

  const dev = readJson(path.join(ROOT, 'package.json'));
  const plugin = readJson(path.join(PLUGIN, '.claude-plugin', 'plugin.json'));
  if (!dev.version || dev.version !== plugin.version) {
    throw new Rejection({ code: 'PACKAGE-VERSION', message: `버전이 다르다: package.json ${dev.version}, plugin.json ${plugin.version}`, fix: ['릴리스마다 두 파일의 version을 같은 값으로 올린다(K-9)'] });
  }

  const esbuild = await loadEsbuild();
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'bin'), { recursive: true });

  // 1. 보드 화면 묶음
  const ui = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'build-site.mjs'), '--out', path.join(out, 'board-ui')], { cwd: ROOT, encoding: 'utf8' });
  if (ui.status !== 0) throw new Rejection({ code: 'PACKAGE-UI', message: `보드 화면을 묶지 못했다: ${ui.stderr || ui.stdout}`, fix: ['node bin/build-site.mjs를 따로 실행해 오류를 고친다'] });
  const uiMeta = await esbuild.build({ entryPoints: [path.join(ROOT, 'site', 'src', 'main.mjs')], bundle: true, write: false, metafile: true, format: 'iife', logLevel: 'silent' });

  // 2. CLI 한 파일. yaml의 Node용 빌드가 CommonJS라 내장 모듈을 require로 부른다 — ESM 묶음에 require를 마련해 둔다
  const cli = await esbuild.build({
    entryPoints: [path.join(PLUGIN, 'bin', 'wb.mjs')], outfile: path.join(out, 'bin', 'wb.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, logLevel: 'warning', legalComments: 'none',
    banner: { js: "import { createRequire as __wbCreateRequire } from 'node:module'; const require = __wbCreateRequire(import.meta.url);" },
  });
  const code = fs.readFileSync(path.join(out, 'bin', 'wb.mjs'), 'utf8');
  if (!code.startsWith('#!/usr/bin/env node')) throw new Rejection({ code: 'PACKAGE-BUNDLE', message: '묶음 첫 줄에 #!/usr/bin/env node가 없다', fix: ['plugin/bin/wb.mjs 첫 줄을 확인한다'] });
  const builtin = new Set(builtinModules);
  const specifiers = [
    ...[...code.matchAll(/^\s*(?:import|export)\b[^;\n]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1]),
    ...[...code.matchAll(/(?:\bimport|\brequire|__require)\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ];
  const externals = specifiers.filter((s) => s && !s.startsWith('node:') && !builtin.has(s.split('/')[0]));
  if (externals.length) throw new Rejection({ code: 'PACKAGE-BUNDLE', message: `묶음에 Node 내장 밖의 import가 남았다: ${[...new Set(externals)].join(', ')}`, fix: ['설치물은 런타임 npm 의존을 두지 않는다(K-6). 해당 모듈을 묶거나 node: 접두를 쓴다'] });

  // 3. 플러그인 파일, 라이선스, 고지
  for (const f of COPY) fs.cpSync(path.join(PLUGIN, f), path.join(out, f), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(out, 'LICENSE'));
  const names = new Set([...bundledPackages(cli.metafile), ...bundledPackages(uiMeta.metafile), 'mermaid', 'highlight.js']);
  fs.writeFileSync(path.join(out, 'THIRD_PARTY_NOTICES.md'), notices(names));

  // 4. 게시 manifest. 런타임 의존이 없다
  const manifest = {
    name: PACKAGE.name,
    version: dev.version,
    description: plugin.description,
    type: 'module',
    bin: { wb: 'bin/wb.mjs' },
    engines: { node: '>=22' },
    license: 'MIT',
    author: PACKAGE.author,
    repository: { type: 'git', url: `git+${PACKAGE.repository}.git` },
    homepage: PACKAGE.repository,
    keywords: ['claude-code', 'plugin', 'kanban', 'workbench'],
    files: ['.claude-plugin/', 'agents/', 'bin/', 'board-ui/', 'hooks/', 'references/', 'skills/', 'templates/', 'board.yml', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
  };
  fs.writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const files = fs.readdirSync(out, { recursive: true }).filter((f) => fs.statSync(path.join(out, f)).isFile());
  return {
    data: { out: rel(out), name: manifest.name, version: manifest.version, files: files.length, bundled: [...names].sort() },
    text: [`만듦: ${rel(out)}/ — ${manifest.name}@${manifest.version}, 파일 ${files.length}개`, `  묶은 라이브러리: ${[...names].sort().join(', ')}`].join('\n'),
  };
}, USAGE, { needsData: false });
