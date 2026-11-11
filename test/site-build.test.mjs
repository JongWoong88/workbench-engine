// 보드 화면 빌드(bin/build-site.mjs): 산출물 구성, 데이터 미포함, 같은 출처만 허용하는 CSP
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('board:build 산출물', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-site-'));
  try {
    const r = spawnSync(process.execPath, [path.join(WB, 'bin', 'build-site.mjs'), '--out', out], { cwd: WB, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(out, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort();
    for (const f of ['index.html', 'app.css', 'app.js', 'vendor/hljs.js', 'vendor/mermaid.min.js', 'vendor/hljs-light.css', 'vendor/hljs-dark.css']) assert.ok(files.includes(f), f);
    // 보드·기록 데이터는 묶음에 없다 — 화면이 보드 API로 읽는다
    assert.ok(!files.some((f) => /^(records|board)(\/|$)|board\.json$/.test(f)), files.join(', '));
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /Content-Security-Policy" content="default-src 'self'; script-src 'self';[^"]*connect-src 'self';/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    const js = fs.readFileSync(path.join(out, 'app.js'), 'utf8');
    // 호스트 API·토큰·인증을 다루지 않는다
    for (const bad of [/client_secret/, /\/oauth\//, /api\/graphql/, /Authorization/]) assert.doesNotMatch(js, bad);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
