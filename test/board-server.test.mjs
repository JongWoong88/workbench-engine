// 로컬 보드: git 읽기(X-3, LB-4), API 처리부(LB-2·LB-3, X-1·X-2·X-5·X-6), wb board 명령
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeWorkspace, withRemote, boardTask } from './fixture.mjs';
import { createGitReader, checkPath, checkRef, BoardPathError } from '../plugin/cli/lib/board-git.mjs';
import { createBoardHandler, startBoardServer } from '../plugin/cli/lib/board-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fx;
let rm;
let servers = [];
beforeEach(() => { fx = makeWorkspace(); rm = withRemote(fx); });
afterEach(() => { servers.forEach((s) => s.close()); servers = []; fx.cleanup(); });

const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: fx.wb, encoding: 'utf8' }).stdout.trim();

test('경로·ref 검사: 허용 폴더의 상대경로와 커밋 해시만 받는다', () => {
  for (const ok of ['board/tasks/KEYA-1.md', 'records/alpha/KEYA-2/discovery.md', 'records/a/b/c.png', 'projects.tsv']) assert.equal(checkPath(ok), ok);
  for (const bad of ['../etc/passwd', '/etc/passwd', 'C:/x', 'records/../board/tasks/x.md', 'records\\x.md', 'board/board.yml', '.git/config', 'records/./x', 'records//x', 'src/x.md', '']) {
    assert.throws(() => checkPath(bad), BoardPathError, bad);
  }
  assert.throws(() => checkRef('--output=/tmp/x'), BoardPathError);
  assert.throws(() => checkRef('HEAD'), BoardPathError);
  assert.equal(checkRef('a'.repeat(40)), 'a'.repeat(40));
});

test('git 읽기: 원격 브랜치의 이슈·파일·마지막 커밋·이진 파일. 작업 트리를 바꾸지 않는다', () => {
  const r = createGitReader({ root: fx.wb, ref: 'origin/main' });
  const head = r.head();
  assert.equal(head, git('rev-parse', 'origin/main'));
  assert.deepEqual(r.listTasks(head).map((t) => t.path), ['board/tasks/KEYA-1.md', 'board/tasks/KEYA-2.md']);
  assert.match(r.loadTasks(head)[0].text, /task_id: KEYA-1/);
  const files = r.readPaths(['projects.tsv', 'records/alpha/KEYA-2/discovery.md', 'records/alpha/nope.md'], head);
  assert.match(files['projects.tsv'], /KEYA/);
  assert.equal(files['records/alpha/nope.md'], null);
  assert.equal(r.lastCommit('records/alpha/KEYA-2/discovery.md', head), head);
  assert.equal(r.lastCommit('records/alpha/nope.md', head), null);
  assert.ok(Buffer.isBuffer(r.readBinary('projects.tsv', head)));

  // 커밋하지 않은 편집과 추적하지 않는 파일은 보이지 않는다. 작업 트리는 그대로다
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Edited locally' }));
  fx.write('records/alpha/secret.md', 'local only\n');
  assert.doesNotMatch(r.readPaths(['board/tasks/KEYA-1.md'], head)['board/tasks/KEYA-1.md'], /Edited locally/);
  assert.equal(r.readPaths(['records/alpha/secret.md'], head)['records/alpha/secret.md'], null);
  assert.match(git('status', '--porcelain'), /KEYA-1\.md/);
});

test('git 읽기 --worktree: 추적 파일의 push 전 편집은 보이고, 추적하지 않는 파일은 안 보인다', () => {
  const r = createGitReader({ root: fx.wb, ref: 'origin/main', worktree: true });
  fx.write('board/tasks/KEYA-1.md', boardTask({ id: 'KEYA-1', title: 'Edited locally' }));
  fx.write('records/alpha/secret.md', 'local only\n');
  const head = r.head();
  assert.match(r.loadTasks(head).find((t) => t.path.endsWith('KEYA-1.md')).text, /Edited locally/);
  assert.equal(r.readPaths(['records/alpha/secret.md'], head)['records/alpha/secret.md'], null);
  assert.equal(r.readBinary('records/alpha/secret.md', head), null);
  assert.equal(r.dirty(), true);
});

const UI = () => {
  const dir = path.join(fx.ws, 'ui');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>board</title>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
};

async function serve(opts = {}) {
  const reader = createGitReader({ root: fx.wb, ref: 'origin/main' });
  const handler = createBoardHandler({ reader, boardText: 'columns: []', config: { host: { type: 'gitlab', web: 'https://git.example' }, repo: 'grp/docs', branch: 'main', fetchIntervalSec: 30 }, staticDir: UI(), ...opts });
  const s = await startBoardServer(handler, { port: 0 });
  servers.push(s.server);
  return s;
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { /* 본문이 JSON이 아니다 */ }
        resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
      });
    }).on('error', reject);
  });
}

test('보드 API: 같은 출처의 읽기 API와 화면. CORS 허용 헤더가 없다', async () => {
  const { server, port } = await serve();
  assert.equal(server.address().address, '127.0.0.1');
  const head = await get(port, '/api/head');
  assert.equal(head.status, 200);
  const sha = git('rev-parse', 'origin/main');
  assert.equal(head.json.commit, sha);
  assert.equal(head.headers['access-control-allow-origin'], undefined);

  const src = await get(port, `/api/sources?ref=${sha}`);
  assert.equal(src.json.boardText, 'columns: []'); // 엔진의 보드 설정이다(git에서 읽지 않는다)
  assert.match(src.json.projectsText, /KEYA/);
  assert.deepEqual(src.json.tasks.map((t) => t.path), ['board/tasks/KEYA-1.md', 'board/tasks/KEYA-2.md']);

  const files = await get(port, `/api/files?ref=${sha}&path=records/alpha/KEYA-2/discovery.md&path=records/x.md`);
  assert.match(files.json.files['records/alpha/KEYA-2/discovery.md'], /# d/);
  assert.equal(files.json.files['records/x.md'], null);
  assert.equal((await get(port, `/api/last-commit?ref=${sha}&path=projects.tsv`)).json.commit, sha);
  assert.equal((await get(port, `/api/blob?ref=${sha}&path=projects.tsv`)).status, 200);
  assert.equal((await get(port, '/api/config')).json.host.type, 'gitlab');

  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal((await get(port, '/app.js')).status, 200);
});

test('보드 API: 경로 이탈·옵션 모양 ref·허용 밖 경로는 400, 화면 밖 파일은 404, GET 외는 405', async () => {
  const { port } = await serve();
  const sha = git('rev-parse', 'origin/main');
  assert.equal((await get(port, `/api/files?ref=${sha}&path=../../etc/passwd`)).status, 400);
  assert.equal((await get(port, `/api/files?ref=${sha}&path=.git/config`)).status, 400);
  assert.equal((await get(port, '/api/files?ref=--output%3D/tmp/x&path=projects.tsv')).status, 400);
  assert.equal((await get(port, `/api/blob?ref=${sha}&path=board/board.yml`)).status, 400);
  assert.equal((await get(port, '/..%2f..%2fprojects.tsv')).status, 404);
  assert.equal((await get(port, '/api/nope')).status, 404);
  const post = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/head', method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(post, 405);
});

test('보드 API: 허용하지 않은 Host는 403(LB-2), 인증 단계가 막으면 처리하지 않는다(X-2), 하위 경로에서도 돈다(X-6)', async () => {
  const { port } = await serve({ allowedHosts: ['127.0.0.1:1'] });
  assert.equal((await get(port, '/api/head')).status, 403);
  assert.equal((await get(port, '/api/head', { Host: 'evil.example' })).status, 403);

  const denied = await serve({ authenticate: (req, res) => { res.writeHead(401); res.end(); return false; } });
  assert.equal((await get(denied.port, '/api/head')).status, 401);

  const sub = await serve({ basePath: '/board/' });
  assert.equal((await get(sub.port, '/board/api/head')).status, 200);
  assert.equal((await get(sub.port, '/board/')).status, 200);
  assert.equal((await get(sub.port, '/api/head')).status, 404);
});

test('보드 API: 다시 띄워도 같은 응답을 준다(X-5)', async () => {
  const a = await serve();
  const b = await serve();
  const sha = git('rev-parse', 'origin/main');
  assert.deepEqual((await get(a.port, `/api/sources?ref=${sha}`)).json, (await get(b.port, `/api/sources?ref=${sha}`)).json);
});

test('보드 API: wb sync 뒤에는 fetch 없이도 바로 새 끝 커밋을 보여 준다', async () => {
  const { port } = await serve();
  const before = (await get(port, '/api/head')).json.commit;
  fx.write('board/tasks/KEYA-3.md', boardTask({ id: 'KEYA-3', title: 'New' }));
  git('add', '-A');
  git('commit', '-qm', 'new');
  git('push', '-q', 'origin', 'main'); // push가 origin/main을 옮긴다
  const after = (await get(port, '/api/head')).json.commit;
  assert.notEqual(after, before);
  assert.equal((await get(port, `/api/sources?ref=${after}`)).json.tasks.length, 3);
});

const boardEnv = (extra = {}) => ({ ...process.env, WORKBENCH_ROOT: fx.wb, WORKSPACE_ROOT: fx.ws, WORKBENCH_CONFIG_DIR: path.join(fx.ws, '.wb-config'), WORKBENCH_BOARD_FILE: path.join(fx.wb, 'board', 'board.yml'), ...extra });

const wbBoard = (args, env) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'bin', 'wb.mjs'), 'board', ...args, '--json'], { encoding: 'utf8', env, timeout: 30000 });
  return { status: r.status, json: JSON.parse(r.stdout), raw: r.stdout + r.stderr };
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('wb board: 터미널이 아니면 백그라운드로 띄우고 바로 돌아오며, 다시 부르면 떠 있는 보드를 알리고, --stop으로 끈다', async () => {
  const env = boardEnv({ WORKBENCH_BOARD_UI: UI() });
  const stateFile = path.join(fx.ws, '.wb-config', 'board.json');
  const first = wbBoard(['--port', '0', '--no-fetch'], env);
  assert.equal(first.status, 0, first.raw);
  try {
    assert.equal(first.json.background, true);
    assert.equal(first.json.reused, false);
    assert.match(first.json.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal((await get(first.json.port, '/api/head')).status, 200); // 부른 프로세스가 끝난 뒤에도 돈다
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).pid, first.json.pid);

    const again = wbBoard(['--no-fetch'], env);
    assert.equal(again.status, 0, again.raw);
    assert.equal(again.json.reused, true);
    assert.equal(again.json.pid, first.json.pid);

    const stopped = wbBoard(['--stop'], env);
    assert.equal(stopped.json.stopped, true, stopped.raw);
    assert.equal(alive(first.json.pid), false);
    assert.equal(fs.existsSync(stateFile), false);
    assert.equal(wbBoard(['--stop'], env).json.stopped, false); // 끈 뒤에는 할 일이 없다
  } finally {
    if (alive(first.json.pid)) process.kill(first.json.pid);
  }
});

test('wb board: 백그라운드 프로세스가 뜨지 못하면 그 거부를 그대로 알린다', async () => {
  const busy = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  try {
    const r = wbBoard(['--port', String(busy.address().port), '--no-fetch'], boardEnv({ WORKBENCH_BOARD_UI: UI() }));
    assert.equal(r.status, 3, r.raw);
    assert.equal(r.json.code, 'BOARD-PORT-BUSY');
  } finally {
    busy.close();
  }
});

test('wb board: 127.0.0.1에 띄우고, Host를 검사하고, 잠금 중에는 fetch를 건너뛴다', async () => {
  const lockFile = path.join(fx.wb, '.git', 'workbench-sync.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now(), label: 'test' })); // 살아 있는 프로세스가 잡은 잠금
  const p = spawn(process.execPath, [path.join(ROOT, 'plugin', 'bin', 'wb.mjs'), 'board', '--port', '0', '--json'], { env: boardEnv({ WORKBENCH_BOARD_ALLOW_NONTTY: '1', WORKBENCH_BOARD_UI: UI() }) });
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      p.stdout.on('data', (c) => { buf += c; try { resolve(JSON.parse(buf)); } catch { /* 더 받는다 */ } });
      p.on('exit', (code) => reject(new Error(`exit ${code}: ${buf}`)));
    });
    assert.match(out.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const head = await get(out.port, '/api/head');
    assert.equal(head.status, 200);
    assert.equal(head.json.fetchedAt, null); // 잠겨 있어 fetch를 건너뛰었다
    assert.equal((await get(out.port, '/api/head', { Host: `localhost:${out.port}` })).status, 200);
    assert.equal((await get(out.port, '/api/head', { Host: `attacker.example:${out.port}` })).status, 403);
  } finally {
    p.kill();
    fs.rmSync(lockFile, { force: true });
  }
});
