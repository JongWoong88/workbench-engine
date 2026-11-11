// wb init: 새 문서 저장소 템플릿. 만든 저장소는 그대로 lint --all을 통과하고 보드 명령이 돈다
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'bin', 'wb.mjs');
let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-init-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const wb = (args, env = {}) => {
  const e = { ...process.env, WORKBENCH_CONFIG_DIR: path.join(tmp, '.cfg'), ...env };
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
  delete e.WORKBENCH_BOARD_FILE;
  const r = spawnSync(process.execPath, [WB, ...args], { encoding: 'utf8', env: e, cwd: tmp });
  return { code: r.status, out: r.stdout, err: r.stderr, json: args.includes('--json') && r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
};
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout.trim();

test('wb init --host gitlab: 템플릿·git·hook을 만들고, 만든 저장소는 lint --all을 통과한다', () => {
  const root = path.join(tmp, 'docs');
  const r = wb(['init', root, '--host', 'gitlab', '--web', 'https://gitlab.example.com', '--repo', 'grp/docs', '--json'], { WORKBENCH_ROOT: undefined });
  assert.equal(r.code, 0, r.out + r.err);
  for (const f of ['board/tasks/.gitkeep', 'records/.gitkeep', 'projects.tsv', 'workbench.config.json', '.githooks/pre-commit', '.gitlab-ci.yml', '.gitattributes', '.gitignore', 'README.md']) assert.ok(fs.existsSync(path.join(root, f)), f);
  assert.ok(!fs.existsSync(path.join(root, '.github')));
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'workbench.config.json'), 'utf8'));
  assert.deepEqual(conf, { formatVersion: 1, host: { type: 'gitlab', web: 'https://gitlab.example.com' }, repo: 'grp/docs', branch: 'main' });
  assert.equal(git(root, 'config', '--get', 'core.hooksPath'), '.githooks');
  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'main');
  // 설정하지 않았으므로 다음 할 일에 data-root가 있다
  assert.ok(r.json.next.some((n) => n.includes('data-root')));
  const lint = wb(['lint', '--all', '--json'], { WORKBENCH_ROOT: root });
  assert.equal(lint.code, 0, lint.out + lint.err);
  assert.equal(lint.json.errors, 0);
  // 이미 문서 저장소면 거부
  assert.equal(wb(['init', root, '--host', 'gitlab', '--json']).json.code, 'INIT-EXISTS');
});

test('wb init --host github: Actions 워크플로를 기본 브랜치로 만들고, --set-data-root로 PC별 설정에 적는다', () => {
  const root = path.join(tmp, 'docs-gh');
  const r = wb(['init', root, '--host', 'github', '--repo', 'owner/docs', '--branch', 'trunk', '--set-data-root', '--json'], { WORKBENCH_ROOT: undefined });
  assert.equal(r.code, 0, r.out + r.err);
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'workbench-lint.yml'), 'utf8');
  assert.match(wf, /branches: \[trunk\]/);
  assert.ok(!fs.existsSync(path.join(root, '.gitlab-ci.yml')));
  assert.equal(git(root, 'symbolic-ref', '--short', 'HEAD'), 'trunk');
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.cfg', 'config.json'), 'utf8'));
  assert.equal(cfg.dataRoot, root);
  // 설정만으로 문서 저장소를 찾는다
  assert.equal(wb(['lint', '--all', '--json'], { WORKBENCH_ROOT: undefined }).code, 0);
});

test('wb init: 호스트 없이, 잘못된 값으로는 만들지 않는다', () => {
  assert.equal(wb(['init', path.join(tmp, 'x')]).code, 2);
  assert.equal(wb(['init', path.join(tmp, 'x'), '--host', 'bitbucket']).code, 2);
  assert.equal(wb(['init', path.join(tmp, 'x'), '--host', 'github', '--web', 'ftp://x']).code, 2);
  assert.ok(!fs.existsSync(path.join(tmp, 'x')));
});

test('예시 파일: 공유 설정·대응표 예시를 새 문서 저장소에 넣어도 lint --all을 통과하고, PC별 설정 예시는 wb config가 아는 키만 쓴다', () => {
  const SAMPLES = path.join(path.dirname(WB), '..', 'templates', 'samples');
  const root = path.join(tmp, 'docs-sample');
  assert.equal(wb(['init', root, '--host', 'github', '--json'], { WORKBENCH_ROOT: undefined }).code, 0);
  for (const f of ['workbench.config.json', 'projects.tsv']) fs.copyFileSync(path.join(SAMPLES, f), path.join(root, f));
  const lint = wb(['lint', '--all', '--json'], { WORKBENCH_ROOT: root });
  assert.equal(lint.code, 0, lint.out + lint.err);
  assert.equal(lint.json.errors, 0, lint.out);
  assert.equal(lint.json.warnings ?? 0, 0, lint.out);
  const user = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'user-config.json'), 'utf8'));
  assert.deepEqual(Object.keys(user).sort(), ['dataRoot', 'remote', 'repoPaths', 'workspaceRoot']);
});
