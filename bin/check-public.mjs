#!/usr/bin/env node
// 공개 전 검사. git이 추적하는 파일(과 --untracked면 무시되지 않은 새 파일)의 내용과 경로에 금지어가 있는지 본다.
// 금지어 목록은 엔진 밖 파일로 받는다(목록을 엔진에 넣으면 그 자체가 공개하지 않을 정보다).
//   목록 형식: 한 줄에 하나. 대소문자를 가리지 않는 글자 그대로의 문자열, 또는 `re:`로 시작하는 정규식. `#`으로 시작하면 주석
// 커밋 메시지와 작성자 검사는 --commits로 한다(공개 저장소의 첫 커밋을 만든 뒤)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run, args, usage } from '../plugin/cli/lib/report.mjs';

const USAGE = `사용법: node bin/check-public.mjs --deny <금지어 파일> [--root <폴더>] [--untracked] [--commits]
  --root       검사할 저장소 (기본 현재 폴더)
  --untracked  추적하지 않는(무시되지 않은) 새 파일도 본다
  --commits    모든 커밋의 메시지·작성자·커미터 이름과 이메일도 본다`;

function loadDeny(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => (l.startsWith('re:') ? { label: l, re: new RegExp(l.slice(3), 'giu') } : { label: l, re: new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') }));
}

const git = (root, a) => spawnSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

run(async () => {
  const { values } = args({ deny: { type: 'string' }, root: { type: 'string' }, untracked: { type: 'boolean' }, commits: { type: 'boolean' } }, USAGE, { positionals: false });
  if (!values.deny) throw usage('--deny <금지어 파일>이 필요하다', USAGE);
  const root = path.resolve(values.root ?? '.');
  const deny = loadDeny(values.deny);
  const lsArgs = ['ls-files', '-z', '--cached', ...(values.untracked ? ['--others', '--exclude-standard'] : [])];
  const files = [...new Set(git(root, lsArgs).stdout.split('\0').filter(Boolean))].filter((f) => fs.existsSync(path.join(root, f)));
  const hits = [];
  const scan = (where, text) => {
    text.split(/\r?\n/).forEach((line, i) => {
      for (const d of deny) {
        d.re.lastIndex = 0;
        const m = d.re.exec(line);
        if (m) hits.push({ where: `${where}${i + 1 > 0 ? `:${i + 1}` : ''}`, term: d.label, text: line.trim().slice(0, 160) });
      }
    });
  };
  for (const f of files) {
    scan(`(경로) ${f}`, f);
    const buf = fs.readFileSync(path.join(root, f));
    if (buf.includes(0)) continue; // 이진 파일은 경로만 본다
    scan(f, buf.toString('utf8'));
  }
  if (values.commits) {
    const log = git(root, ['log', '--all', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x01']).stdout;
    for (const entry of log.split('\x01').map((e) => e.trim()).filter(Boolean)) {
      const [sha, author, committer, body] = entry.split('\0');
      scan(`(커밋 ${sha.slice(0, 7)} 작성자)`, author);
      scan(`(커밋 ${sha.slice(0, 7)} 커미터)`, committer);
      scan(`(커밋 ${sha.slice(0, 7)} 메시지)`, body ?? '');
    }
  }
  const byTerm = {};
  for (const h of hits) byTerm[h.term] = (byTerm[h.term] ?? 0) + 1;
  const result = { root, files: files.length, hits: hits.length, byTerm, items: hits };
  if (hits.length) {
    return {
      exit: 1, data: { ok: false, ...result },
      text: [`거부: 금지어 ${hits.length}건 (파일 ${files.length}개 검사)`, ...hits.slice(0, 40).map((h) => `  ${h.where} [${h.term}] ${h.text}`), ...(hits.length > 40 ? [`  … 외 ${hits.length - 40}건 (--json으로 전체)`] : [])].join('\n'),
    };
  }
  return { data: result, text: `통과: 금지어 0건 (파일 ${files.length}개${values.commits ? ', 커밋 포함' : ''})` };
}, USAGE, { needsData: false });
