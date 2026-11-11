// 문서 저장소의 공유 설정(workbench.config.json)과 PC별 원격 이름: 기본값, 호스트 기본 주소, 브랜치·원격을 따르는 sync, 문서 루트
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseSharedConfig } from '../plugin/cli/lib/shared-config.mjs';
import { makeWorkspace, cli, boardTask } from './fixture.mjs';

test('기본값: 키를 모두 생략할 수 있다', () => {
  const { config, problems } = parseSharedConfig('{}');
  assert.deepEqual(problems, []);
  assert.deepEqual(config, { formatVersion: 1, host: { type: null, web: null, api: null }, repo: null, branch: 'main', docRoots: ['src/main/resources/docs', 'docs'], board: { fetchIntervalSec: 30 } });
});

test('호스트별 기본 주소', () => {
  assert.deepEqual(parseSharedConfig('{"host": {"type": "github"}}').config.host, { type: 'github', web: 'https://github.com', api: 'https://api.github.com' });
  assert.deepEqual(parseSharedConfig('{"host": {"type": "github", "web": "https://ghe.example.com/"}}').config.host, { type: 'github', web: 'https://ghe.example.com', api: 'https://ghe.example.com/api/v3' });
  assert.deepEqual(parseSharedConfig('{"host": {"type": "gitlab", "web": "https://git.example.com"}}').config.host, { type: 'gitlab', web: 'https://git.example.com', api: 'https://git.example.com/api/v4' });
  assert.equal(parseSharedConfig('{').problems[0].severity, 'error');
});

let fx;
beforeEach(() => { fx = makeWorkspace(); });
afterEach(() => fx.cleanup());

const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test('sync: 공유 설정의 branch와 PC별 설정의 remote를 따른다', () => {
  // 기본 브랜치 trunk, 원격 이름 upstream인 문서 저장소
  fx.write('workbench.config.json', '{"branch": "trunk"}\n');
  git(fx.wb, 'add', '-A');
  git(fx.wb, 'commit', '-qm', 'config');
  git(fx.wb, 'branch', '-m', 'trunk');
  const remote = path.join(fx.ws, 'remote.git');
  git(fx.ws, 'init', '-q', '--bare', '-b', 'trunk', remote);
  git(fx.wb, 'remote', 'add', 'upstream', remote);
  git(fx.wb, 'push', '-q', '-u', 'upstream', 'trunk');

  // 원격 이름을 설정하기 전에는 origin을 찾다 멈춘다
  assert.equal(cli(fx, 'sync', ['begin'], { json: true }).json.code, 'SYNC-NO-REMOTE');
  assert.equal(cli(fx, 'config', ['set', 'remote', 'upstream']).code, 0);
  const begin = cli(fx, 'sync', ['begin'], { json: true });
  assert.equal(begin.code, 0, begin.out + begin.err);

  fx.write('board/tasks/KEYA-3.md', boardTask({ id: 'KEYA-3', title: 'New' }));
  const c = cli(fx, 'sync', ['commit', '--files', 'board/tasks/KEYA-3.md', '--message', 'add'], { json: true });
  assert.equal(c.code, 0, c.out + c.err);
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'trunk').split('\n')[0], 'add');

  // 기본 브랜치가 아닌 곳에서는 쓰기 전에 멈춘다
  git(fx.wb, 'switch', '-q', '-c', 'main');
  const off = cli(fx, 'sync', ['begin'], { json: true });
  assert.equal(off.json.code, 'SYNC-NOT-MAIN');
  assert.match(off.json.fix[0], /trunk/);
});

test('sync: 공유 설정이 깨졌으면 쓰기 전에 거부한다', () => {
  fx.write('workbench.config.json', '{"branch": ""}');
  const r = cli(fx, 'sync', ['begin'], { json: true });
  assert.equal(r.code, 1);
  assert.equal(r.json.code, 'CONFIG-SHARED');
});

test('absorb-candidates: 문서 루트 후보는 공유 설정 docRoots를 따른다', () => {
  const repoDocs = path.join(fx.ws, 'org', 'alpha-repo', 'handbook');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(repoDocs)}, {recursive: true})`]);
  const repos = () => cli(fx, 'absorb-candidates', [], { json: true }).json.candidates[0].repos[0].docRoots;
  assert.deepEqual(repos(), ['org/alpha-repo/docs']);
  fx.write('workbench.config.json', '{"docRoots": ["handbook"]}');
  assert.deepEqual(repos(), ['org/alpha-repo/handbook']);
});
