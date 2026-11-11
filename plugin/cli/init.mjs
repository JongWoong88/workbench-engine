#!/usr/bin/env node
// 새 문서 저장소를 만든다. 보드·기록 폴더, 대응표 머리, 공유 설정, pre-commit hook, 호스트에 맞는 CI 파일을 둔다.
//   폴더가 git 저장소가 아니면 git init 한다. core.hooksPath를 .githooks로 건다. 커밋·push는 사람이 한다.
import fs from 'node:fs';
import path from 'node:path';
import { run, args, usage, Rejection } from './lib/report.mjs';
import { ENGINE, git, exists, readUserConfig, writeUserConfig, USER_CONFIG } from './lib/workbench.mjs';
import { FORMAT_VERSION, HOST_TYPES, parseSharedConfig } from './lib/shared-config.mjs';

const USAGE = `사용법: wb init <폴더> --host gitlab|github [--web <호스트 주소>] [--repo <호스트의 저장소 경로>] [--branch <기본 브랜치>] [--set-data-root]
  <폴더>          새 문서 저장소 폴더. 없으면 만든다. 이미 board/가 있으면 거부한다
  --host          문서 저장소와 서비스 저장소의 호스트. 보드의 파일·저장소 링크 형식과 CI 파일을 정한다
  --web           호스트 웹 주소. gitlab이면 필요하다(예: https://gitlab.example.com). github 기본은 https://github.com
  --repo          호스트에서 이 문서 저장소의 경로(예: group/docs). 보드의 파일 링크에 쓴다
  --branch        기본 브랜치 (기본 main)
  --set-data-root 이 PC의 문서 저장소 위치로 설정한다(wb config set data-root)`;

const TEMPLATES = path.join(ENGINE, 'templates');

const GITATTRIBUTES = `# 문서·대응표·설정·hook은 LF 고정 (CRLF면 TSV 마지막 열에 CR이 붙고, sh hook이 CR 때문에 실패한다)
*.md   text eol=lf
*.tsv  text eol=lf
*.json text eol=lf
*.yml  text eol=lf
*.mjs  text eol=lf
*.js   text eol=lf
*.html text eol=lf
*.css  text eol=lf
.githooks/* text eol=lf
`;
const GITIGNORE = 'Thumbs.db\nDesktop.ini\n.DS_Store\n~$*\n';
const PROJECTS = '# project\tkey\trepos\tremote\n# 한 줄에 project 하나. 열은 탭으로 나눈다. 예:\n# app\tAPP\tgroup/app\tgroup/app\n';
const README = `# 작업 문서 저장소

이슈(\`board/tasks/\`), 기록(\`records/\`), 대응표(\`projects.tsv\`), 공유 설정(\`workbench.config.json\`)을 둔다. Claude Code 플러그인 \`workbench\`의 스킬과 \`wb\` 명령으로 다룬다.

## 처음 할 일

1. \`projects.tsv\`에 project를 추가한다: project 이름, task_id 키, 서비스 저장소의 논리 경로(워크스페이스 루트 기준), 호스트 저장소 경로. 열은 탭으로 나눈다
2. 커밋하고 기본 브랜치에 push한다
3. 각 PC: 플러그인을 설치하고 \`wb config set data-root <이 저장소 clone 경로>\`, 이 저장소에서 \`git config core.hooksPath .githooks\`
4. 보드: \`wb board --open\`
`;

function writeIfAbsent(file, text, mode) {
  if (exists(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
  return true;
}

run(async () => {
  const { values, positionals } = args({ host: { type: 'string' }, web: { type: 'string' }, repo: { type: 'string' }, branch: { type: 'string' }, 'set-data-root': { type: 'boolean' } }, USAGE);
  if (positionals.length !== 1) throw usage('문서 저장소 폴더 하나를 준다', USAGE);
  if (!HOST_TYPES.includes(values.host)) throw usage(`--host는 ${HOST_TYPES.join(' 또는 ')}다`, USAGE);
  const root = path.resolve(positionals[0]);
  if (exists(path.join(root, 'board'))) {
    throw new Rejection({ code: 'INIT-EXISTS', message: `이미 문서 저장소처럼 보인다(board/가 있다): ${root}`, fix: ['기존 문서 저장소면 wb config set data-root로 쓴다. 새로 만들려면 빈 폴더를 준다'], owner: 'user' });
  }
  const branch = values.branch ?? 'main';
  const shared = { formatVersion: FORMAT_VERSION, host: { type: values.host, ...(values.web ? { web: values.web } : {}) }, ...(values.repo ? { repo: values.repo } : {}), branch };
  const sharedText = `${JSON.stringify(shared, null, 2)}\n`;
  const problems = parseSharedConfig(sharedText).problems.filter((p) => p.severity === 'error');
  if (problems.length) throw usage(`설정 값이 맞지 않는다: ${problems.map((p) => p.message).join(' / ')}`, USAGE);

  fs.mkdirSync(root, { recursive: true });
  const made = [];
  const put = (rel, text, mode) => { if (writeIfAbsent(path.join(root, ...rel.split('/')), text, mode)) made.push(rel); };
  put('board/tasks/.gitkeep', '');
  put('records/.gitkeep', '');
  put('projects.tsv', PROJECTS);
  put('workbench.config.json', sharedText);
  put('.githooks/pre-commit', fs.readFileSync(path.join(TEMPLATES, 'githooks', 'pre-commit'), 'utf8'), 0o755);
  if (values.host === 'gitlab') {
    put('.gitlab-ci.yml', fs.readFileSync(path.join(TEMPLATES, 'ci', 'gitlab-ci.yml'), 'utf8'));
  } else {
    put('.github/workflows/workbench-lint.yml', fs.readFileSync(path.join(TEMPLATES, 'ci', 'github-lint.yml'), 'utf8').replace('branches: [main]', `branches: [${branch}]`));
  }
  put('.gitattributes', GITATTRIBUTES);
  put('.gitignore', GITIGNORE);
  put('README.md', README);

  const notes = [];
  if (!exists(path.join(root, '.git'))) {
    const r = git(['init', '-q', '-b', branch], root);
    if (!r.ok) throw new Rejection({ code: 'INIT-GIT', message: `git init에 실패했다: ${r.stderr.trim()}`, fix: ['git이 설치되어 있는지 확인한다'], owner: 'user' });
    notes.push(`git 저장소를 만들었다(기본 브랜치 ${branch}). 원격은 직접 연결한다: git remote add origin <주소>`);
  }
  git(['config', 'core.hooksPath', '.githooks'], root);
  if (values['set-data-root']) {
    writeUserConfig({ ...readUserConfig(), dataRoot: root });
    notes.push(`이 PC의 문서 저장소 위치를 설정했다(${USER_CONFIG})`);
  }
  if (values.host === 'gitlab' && !values.web) notes.push('--web이 없어 보드가 깃랩 링크를 만들지 않는다. workbench.config.json의 host.web에 깃랩 주소를 적는다');

  const next = ['projects.tsv에 project를 추가한다(키는 임의로 정하지 말고 팀과 정한다)', '커밋하고 기본 브랜치에 push한다', ...(values['set-data-root'] ? [] : [`wb config set data-root ${root}`]), 'wb board --open'];
  return {
    data: { root, host: values.host, branch, made, notes, next },
    text: [`만듦: ${root}`, ...made.map((f) => `  ${f}`), ...notes.map((n) => `  참고: ${n}`), ...next.map((n) => `  다음: ${n}`)].join('\n'),
  };
}, USAGE, { needsData: false });
