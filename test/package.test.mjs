// 게시 패키지(bin/build-package.mjs): node_modules 없는 곳에 풀어도 wb가 돈다(K-6),
// 문서 저장소 CI가 쓰는 lint --all의 인자·WORKBENCH_ROOT·종료 코드(K-7), 버전 일치(K-9), 설치 폴더에 쓰지 않는다
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, withRemote } from './fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let pkg; // 풀어 놓은 패키지 폴더
let fx;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pkg-'));
  const out = path.join(tmp, 'build');
  const b = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'build-package.mjs'), '--out', out, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  // npm pack으로 실제 게시 목록(files)만 담은 tarball을 만들고, node_modules가 없는 폴더에 푼다
  const packDir = path.join(tmp, 'pack');
  fs.mkdirSync(packDir);
  const p = spawnSync('npm', ['pack', out, '--pack-destination', packDir, '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(p.status, 0, p.stderr);
  const tarball = fs.readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  const unpack = path.join(tmp, 'install');
  fs.mkdirSync(unpack);
  // 상대 경로로 푼다(GNU tar는 'C:'를 원격 호스트로 읽는다)
  const x = spawnSync('tar', ['-xzf', tarball, '-C', path.join('..', 'install')], { cwd: packDir, encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  pkg = path.join(unpack, 'package');
  fx = makeWorkspace();
  withRemote(fx); // wb board는 원격 기본 브랜치를 보여 준다
});
after(() => { fx?.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

const env = (extra = {}) => ({ ...process.env, NODE_PATH: '', WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), ...extra });
const wb = (args, extra) => {
  const r = spawnSync(process.execPath, [path.join(pkg, 'bin', 'wb.mjs'), ...args], { cwd: tmp, encoding: 'utf8', env: env(extra) });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort();

test('패키지 구성: bin은 wb 하나, 런타임 의존 없음, 플러그인과 버전이 같다, 소스 cli/와 node_modules가 없다', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.bin), ['wb']);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(pkg, '.claude-plugin', 'plugin.json'), 'utf8')).version, manifest.version);
  const files = listing(pkg);
  for (const f of ['bin/wb.mjs', 'bin/wb', 'bin/wb.cmd', 'board.yml', 'board-ui/index.html', 'hooks/hooks.json', 'hooks/session-end.mjs', 'hooks/board-sessions.mjs', 'references/workbench-format.md', 'skills/plan/SKILL.md', 'templates/githooks/pre-commit', 'templates/ci/gitlab-ci.yml', 'templates/ci/github-lint.yml', 'templates/samples/workbench.config.json', 'templates/samples/projects.tsv', 'templates/samples/user-config.json', 'skills/setup/SKILL.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('cli/') || f.includes('node_modules')), 'cli/·node_modules가 패키지에 있다');
  assert.equal(wb(['--version']).out.trim(), manifest.version);
});

test('K-7: 문서 저장소 CI의 lint --all 계약 — WORKBENCH_ROOT로 문서 저장소를 받고, 통과 0·위반 1', () => {
  const before = listing(pkg);
  const ok = wb(['lint', '--all', '--json'], { WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml') });
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.equal(JSON.parse(ok.out).ok, true);
  fx.write('records/alpha/KEYA-1/bad.md', '# 프론트매터 없음\n');
  const bad = wb(['lint', '--all', '--json']);
  assert.equal(bad.code, 1, bad.out + bad.err);
  assert.ok(JSON.parse(bad.out).findings.some((f) => f.rule === 'REC-FM-MISSING'));
  fs.rmSync(path.join(fx.wb, 'records', 'alpha', 'KEYA-1'), { recursive: true, force: true });
  // 문서 저장소 없이 부르면 환경 오류
  assert.equal(wb(['lint', '--all', '--json'], { WORKBENCH_ROOT: '' }).code, 3);
  assert.deepEqual(listing(pkg), before, '설치 폴더에 무언가 썼다');
});

test('묶음 설치물: 엔진의 board.yml을 쓰고, 명령과 거부 안내가 wb 형식이다', () => {
  const found = wb(['find-task', 'KEYA-1', '--json']);
  assert.equal(found.code, 0, found.out + found.err);
  const unknown = wb(['find-task', 'KEYA-1', '--json'], { WORKBENCH_BOARD_FILE: '' });
  assert.equal(unknown.code, 0, unknown.err); // 패키지 안의 board.yml로도 읽는다
  const rej = wb(['new-record', '--to', 'KEYA-2', '--name', 'x.md', '--title', 'x', '--json']);
  assert.equal(JSON.parse(rej.out).code, 'RECORD-FROZEN');
  const help = wb(['--help']);
  assert.ok(help.out.includes(`엔진: ${pkg}`), help.out);
});

test('묶음 설치물: wb board가 패키지의 화면을 서빙한다', async () => {
  const p = spawn(process.execPath, [path.join(pkg, 'bin', 'wb.mjs'), 'board', '--port', '0', '--no-fetch', '--json'], { cwd: tmp, env: env({ WORKBENCH_BOARD_ALLOW_NONTTY: '1' }) });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      p.stdout.on('data', (c) => { buf += c; try { resolve(JSON.parse(buf)); } catch { /* 더 받는다 */ } });
      p.on('exit', (code) => reject(new Error(`exit ${code}: ${buf}`)));
    });
    assert.ok(out.port, JSON.stringify(out));
    const get = (u) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: out.port, path: u }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(await get('/'), 200);
    assert.equal(await get('/app.js'), 200);
    assert.equal(await get('/api/head'), 200);
  } finally {
    p.kill();
  }
});
