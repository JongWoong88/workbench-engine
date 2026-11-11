import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// 감사는 실제 워크스페이스 경로를 기준으로 판정하므로, 임시 경로를 워크스페이스로 두고 불러온다
const WS = path.join(os.tmpdir(), 'replay-audit-ws');
process.env.WORKSPACE_ROOT = WS;
const { auditText } = await import('../bin/lib/replay-audit.mjs');

const line = (o) => JSON.stringify(o);
const toolUse = (name, input) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const toolResult = (text, isError = true) => line({ type: 'user', message: { content: [{ type: 'tool_result', is_error: isError, content: text }] } });

test('replay 감사: 실제 워크스페이스 경로를 읽으면 LEAK-PATH', () => {
  const f = auditText([toolUse('Read', { file_path: path.join(WS, 'workbench', 'records', 'a.md') })].join('\n'));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'LEAK-PATH');
});

test('replay 감사: 슬래시 표기·셸 명령 안의 실제 경로도 잡는다', () => {
  const fwd = WS.split(path.sep).join('/');
  const f = auditText(toolUse('Bash', { command: `cat ${fwd}/ws/llm-wiki/index.md` }));
  assert.equal(f[0]?.rule, 'LEAK-PATH');
});

test('replay 감사: 사용자 설정 경로(~/.claude)를 건드리면 LEAK-PATH', () => {
  const f = auditText(toolUse('Glob', { pattern: '~/.claude/projects/**/*.jsonl' }));
  assert.equal(f[0]?.rule, 'LEAK-PATH');
});

test('replay 감사: 권한 규칙에 막힌 호출은 DENIED', () => {
  const f = auditText(toolResult('Permission to use Bash with command cat x has been denied.'));
  assert.equal(f[0]?.rule, 'DENIED');
});

test('replay 감사: 복제본 안 경로와 일반 실패는 위반이 아니다', () => {
  const f = auditText([
    toolUse('Read', { file_path: 'D:/aidlc-sandbox/X/workspace/ws/CLAUDE.md' }),
    toolResult('File does not exist.'),
    'not json',
  ].join('\n'));
  assert.equal(f.length, 0);
});

test('replay 복제본의 workbench: 빈 board/로 명령과 lint가 동작한다', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { makeWorkspace, cli } = await import('./fixture.mjs');
  const { makeEmptyWorkbench } = await import('../bin/lib/replay.mjs');
  const src = makeWorkspace();
  const dstWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-replay-'));
  try {
    const dst = path.join(dstWs, 'workbench');
    makeEmptyWorkbench(src.wb, dst);
    assert.deepEqual(fs.readdirSync(path.join(dst, 'board', 'tasks')), ['.gitkeep']);
    assert.equal(fs.existsSync(path.join(dst, '.kanbn')), false);
    const fx = { wb: dst, ws: dstWs };
    // 복제본은 엔진의 보드 설정을 쓴다(fixture의 보드 설정을 가리키지 않는다)
    const engineBoard = { WORKBENCH_BOARD_FILE: undefined };
    assert.equal(cli(fx, 'find-task', ['KEYA-1'], { json: true, env: engineBoard }).json.code, 'TASK-NOT-FOUND');
    // 전역 git 설정이 없는 샌드박스에서도 복제본의 user.name으로 이슈를 만든다
    fs.writeFileSync(path.join(dstWs, 'empty.gitconfig'), '');
    const env = { ...engineBoard, GIT_CONFIG_GLOBAL: path.join(dstWs, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
    const made = cli(fx, 'new-task', ['--project', 'alpha', '--tag', 'feature', '--title', 'Replay', '--no-fetch'], { json: true, env });
    assert.equal(made.code, 0, made.out + made.err);
    const { parseTaskText } = await import('../plugin/cli/lib/board.mjs');
    assert.equal(parseTaskText(fs.readFileSync(path.join(dst, made.json.file), 'utf8')).data.author, 'replay');
    const lint = cli(fx, 'lint', ['--all'], { json: true, env: engineBoard });
    assert.equal(lint.json.errors, 0, JSON.stringify(lint.json.findings, null, 2));
  } finally {
    src.cleanup();
    fs.rmSync(dstWs, { recursive: true, force: true });
  }
});

test('replay 복제본: 플러그인을 복제본에서 싣고, wb는 복제본에 쓰며 원격 없이 로컬 커밋만 한다', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { makeEmptyWorkbench, runInvocation, sandboxPermissions } = await import('../bin/lib/replay.mjs');
  const realWb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dstWs = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-replay-'));
  try {
    const dst = path.join(dstWs, 'workbench');
    makeEmptyWorkbench(realWb, dst);
    // 엔진 저장소에는 대응표가 없다(문서 저장소 소유). 시험용 대응표를 둔다
    if (!fs.existsSync(path.join(dst, 'projects.tsv'))) fs.writeFileSync(path.join(dst, 'projects.tsv'), '# project\tkey\trepos\tgitlab\ncommon\tKEYC\t-\t-\n');
    assert.ok(fs.existsSync(path.join(dst, 'plugin', 'bin', 'wb.mjs')));
    assert.equal(fs.existsSync(path.join(dst, 'workbench.local.json')), false);
    assert.equal(spawnSync('git', ['ls-files', 'node_modules'], { cwd: dst, encoding: 'utf8' }).stdout.trim(), '');

    const info = { workspace: dstWs.split(path.sep).join('/'), config: '/cfg', plugin: `${dst.split(path.sep).join('/')}/plugin` };
    const { args, env } = runInvocation(info);
    assert.equal(args[args.indexOf('--plugin-dir') + 1], info.plugin);
    assert.equal(env.WORKBENCH_SYNC, 'local');
    assert.equal(env.WORKBENCH_ROOT, `${info.workspace}/workbench`);
    assert.ok(sandboxPermissions({ sbx: '/s', ws: '/s/workspace', realWs: '/r', realHome: '/h' }).allow.includes('Bash(wb *)'));
    // Windows 경로는 //d/… 표기여야 규칙이 맞는다
    const win = sandboxPermissions({ sbx: 'D:/aidlc-sandbox/X', ws: 'D:/aidlc-sandbox/X/workspace', realWs: 'D:/src/workspace', realHome: 'C:/Users/u/.claude' });
    assert.ok(win.allow.includes('Edit(//d/aidlc-sandbox/X/workspace/**)'), win.allow.join(' '));
    assert.ok(win.deny.includes('Read(//d/src/workspace/**)'), win.deny.join(' '));
    assert.ok(win.deny.includes('Read(//c/Users/u/.claude/**)'), win.deny.join(' '));
    assert.ok(sandboxPermissions({ sbx: '/s', ws: '/s/workspace', realWs: '/r', realHome: '/h' }).deny.includes('Read(//r/**)'));

    // 복제본 플러그인의 wb는 복제본 workbench에 쓴다 (실제 보드에 닿지 않는다)
    const e = { ...process.env, ...env, CLAUDE_CONFIG_DIR: undefined };
    delete e.CLAUDE_CONFIG_DIR;
    const wb = (...a) => spawnSync(process.execPath, [path.join(dst, 'plugin', 'bin', 'wb.mjs'), ...a], { encoding: 'utf8', env: e });
    const made = wb('new-task', '--project', 'common', '--tag', 'feature', '--title', 'Replay plugin', '--no-fetch', '--json');
    assert.equal(made.status, 0, made.stdout + made.stderr);
    assert.ok(fs.existsSync(path.join(dst, JSON.parse(made.stdout).file)));
    const committed = wb('sync', 'commit', '--files', JSON.parse(made.stdout).file, '--message', 'm', '--json');
    assert.equal(committed.status, 0, committed.stdout + committed.stderr);
    assert.equal(JSON.parse(committed.stdout).pushed, false);
    assert.ok(JSON.parse(committed.stdout).committed);
  } finally {
    fs.rmSync(dstWs, { recursive: true, force: true });
  }
});
