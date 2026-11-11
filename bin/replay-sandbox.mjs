#!/usr/bin/env node
// replay 사례를 착수 시점 복제본으로 만든다.
//   사례 정의(JSON)의 위치 필드는 워크스페이스 루트 기준 논리 경로다:
//     repos[{path, commit}] 코드 저장소, wiki{path, commit} 위키 저장소(선택), workspaceDocs[] 상위 안내 문서(기본 CLAUDE.md),
//     sharedDocs[] 사례 키워드(leakKeywords)가 든 문서를 빼고 복사할 공통 문서 폴더(선택), cwd 실행 폴더(기본 워크스페이스 루트)
//   <out>/<id>/workspace      원본 워크스페이스와 같은 구조. 코드·위키는 기준 커밋까지의 이력만, workbench는 빈 보드·빈 기록
//   <out>/<id>/claude-config  전용 CLAUDE_CONFIG_DIR. 권한 설정만 둔다. 스킬·에이전트는 복제본 workbench의 플러그인이 준다
// 읽는 것은 사례 정의(JSON)뿐이다. 정답 문서는 읽지 않는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, args, usage, Rejection } from '../plugin/cli/lib/report.mjs';
import { fileURLToPath } from 'node:url';
import { WS, TSV, git, read, exists, repoDir } from '../plugin/cli/lib/workbench.mjs';
import { loadCase, cloneAt, rewritePaths, copyDir, mdFiles, posixAbs, makeEmptyWorkbench, sandboxPermissions } from './lib/replay.mjs';

const USAGE = `사용법: node bin/replay-sandbox.mjs --cases <사례 정의.json> --case <id> --out <복제본 루트> [--force]
  --out     워크스페이스(${WS}) 밖의 폴더. 사례별 하위 폴더를 만든다
  --force   같은 사례의 복제본이 있으면 지우고 다시 만든다`;

run(async () => {
  const { values } = args({
    cases: { type: 'string' }, case: { type: 'string' }, out: { type: 'string' },
    force: { type: 'boolean' },
  }, USAGE, { positionals: false });
  if (!values.cases || !values.case || !values.out) throw usage('--cases, --case, --out이 모두 필요하다', USAGE);

  const c = loadCase(path.resolve(values.cases), values.case);
  const outRoot = path.resolve(values.out);
  const inside = (p, root) => !path.relative(root, p).startsWith('..') && !path.isAbsolute(path.relative(root, p));
  if (inside(outRoot, WS)) {
    throw new Rejection({ code: 'REPLAY-OUT-INSIDE', message: `복제본 루트가 워크스페이스 안에 있다: ${outRoot}`, fix: `${WS} 밖의 폴더를 --out으로 준다 (상위 CLAUDE.md가 자동으로 읽히는 것을 막기 위해서다)` });
  }
  const caseDir = path.join(outRoot, c.id);
  if (exists(caseDir)) {
    if (!values.force) throw new Rejection({ code: 'REPLAY-EXISTS', message: `복제본이 이미 있다: ${caseDir}`, fix: '다시 만들려면 --force를 붙인다' });
    fs.rmSync(caseDir, { recursive: true, force: true });
  }
  const ws = path.join(caseDir, 'workspace');
  const cfg = path.join(caseDir, 'claude-config');
  const log = [];

  // 1. 코드 저장소: 기준 커밋까지의 이력만
  for (const r of c.repos) {
    const sha = cloneAt(repoDir(r.path), r.commit, path.join(ws, r.path));
    log.push(`코드 ${r.path} @ ${sha.slice(0, 10)}`);
  }

  // 2. 위키(있으면): 착수 전 커밋까지
  const wiki = c.wiki && typeof c.wiki === 'object' ? c.wiki : null;
  if (c.wiki && !wiki) throw new Rejection({ code: 'REPLAY-CASE-WIKI', message: 'wiki는 {path, commit} 객체다', fix: ['사례 정의의 wiki를 {"path": "<위키 저장소 논리 경로>", "commit": "<커밋>"}로 고친다'] });
  if (wiki) {
    const wikiSha = cloneAt(repoDir(wiki.path), wiki.commit, path.join(ws, wiki.path));
    log.push(`위키 ${wiki.path} @ ${wikiSha.slice(0, 10)}`);
  }

  // 3. workbench: 최신 도구만, 빈 보드·빈 기록, 새 git 저장소
  const wb = path.join(ws, 'workbench');
  makeEmptyWorkbench(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), wb);
  // 대응표는 문서 저장소 소유다. 엔진에는 없으므로 지금 문서 저장소의 것을 복제본에 둔다
  if (exists(TSV)) fs.copyFileSync(TSV, path.join(wb, 'projects.tsv'));
  log.push('workbench: 최신 bin·규칙, 빈 보드·빈 기록');

  // 4. 상위 안내 문서(있을 때만 — workbench 규칙은 플러그인이 준다)와 공통 문서 폴더. 사례 키워드가 든 문서는 뺀다
  const wsDocs = (c.workspaceDocs ?? ['CLAUDE.md']).map((f) => path.join(...f.split('/'))).filter((f) => exists(path.join(WS, f)));
  for (const f of wsDocs) fs.copyFileSync(path.join(WS, f), path.join(ws, f));
  const keywords = c.leakKeywords ?? [];
  const excluded = [];
  const sharedDocs = c.sharedDocs ?? [];
  for (const d of sharedDocs) {
    copyDir(path.join(WS, ...d.split('/')), path.join(ws, ...d.split('/')), (p) => {
      if (!p.endsWith('.md')) return true;
      const hit = keywords.find((k) => read(p).includes(k));
      if (hit) excluded.push(`${path.relative(WS, p)} (${hit})`);
      return !hit;
    });
  }
  if (sharedDocs.length) log.push(`공통 문서 ${sharedDocs.join(', ')}: 키워드로 제외 ${excluded.length}건${excluded.length ? ` — ${excluded.join(', ')}` : ''}`);

  // 5. 전용 설정: 권한, 빈 MCP. 스킬·에이전트는 복제본 workbench의 플러그인을 replay-run이 --plugin-dir로 싣는다
  const home = path.join(os.homedir(), '.claude');
  const settings = { permissions: sandboxPermissions({ sbx: posixAbs(caseDir), ws: posixAbs(ws), realWs: posixAbs(WS), realHome: posixAbs(home) }) };
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  fs.writeFileSync(path.join(cfg, 'empty-mcp.json'), '{ "mcpServers": {} }\n');
  log.push(`전용 설정: dontAsk + deny, 플러그인 ${posixAbs(path.join(wb, 'plugin'))}`);

  // 6. 절대경로를 복제본 경로로 바꾼다 (코드 저장소는 건드리지 않는다)
  const targets = [
    ...wsDocs.map((f) => path.join(ws, f)), path.join(wb, 'CLAUDE.md'),
    ...sharedDocs.flatMap((d) => mdFiles(path.join(ws, ...d.split('/')))), ...(wiki ? mdFiles(path.join(ws, ...wiki.path.split('/'))) : []),
    ...mdFiles(path.join(wb, 'plugin')),
  ];
  let changed = 0;
  for (const f of targets) {
    const before = read(f);
    const after = rewritePaths(before, { workspace: ws, config: cfg });
    if (after !== before) { fs.writeFileSync(f, after); changed++; }
  }
  log.push(`경로 바꾸기: ${changed}개 파일`);
  // 바꾼 workbench 파일을 첫 커밋에 넣는다. 남겨 두면 실행 중 커밋되지 않은 변경으로 보인다
  git(['add', '-A'], wb);
  git(['-c', 'user.name=replay', '-c', 'user.email=replay@local', 'commit', '-q', '--amend', '--no-edit'], wb);

  // 7. 입력과 실행 정보
  fs.writeFileSync(path.join(caseDir, 'input.md'), `${c.title}\n\n${c.input}\n`);
  const cwd = path.join(ws, ...(c.cwd ?? '.').split('/'));
  const info = { id: c.id, created: new Date().toISOString(), workspace: posixAbs(ws), cwd: posixAbs(cwd), config: posixAbs(cfg), plugin: posixAbs(path.join(wb, 'plugin')) };
  fs.writeFileSync(path.join(caseDir, 'sandbox.json'), JSON.stringify(info, null, 2) + '\n');

  const text = [`생성: ${caseDir}`, ...log.map((l) => `  ${l}`),
    `  다음: 전용 설정으로 한 번 로그인한다 — CLAUDE_CONFIG_DIR=${posixAbs(cfg)} claude (대화창에서 /login)`,
    `  다음: node bin/replay-run.mjs --sandbox ${posixAbs(caseDir)} --prompt-file <프롬프트.md>`].join('\n');
  return { data: { caseDir: posixAbs(caseDir), ...info, excluded }, text };
}, USAGE);
