#!/usr/bin/env node
// 이 PC의 workbench 설정(~/.workbench/config.json, 저장소 밖)을 읽고 쓴다.
//   data-root:      문서 저장소(board/, records/, projects.tsv가 있는 clone) 경로
//   workspace-root: 서비스 저장소들의 공통 상위 폴더. projects.tsv의 저장소 논리 경로가 이 폴더 기준이다
//   repo-path:      저장소 논리 경로 하나를 이 PC의 실제 폴더로 바꾼다
//   board-autostart: Claude Code 세션이 시작되면 보드를 띄우고, 세션이 모두 끝나면 끈다(기본 off)
import fs from 'node:fs';
import path from 'node:path';
import { run, args, usage, Rejection } from './lib/report.mjs';
import { DATA, WS, WS_SOURCE, REPO_PATHS, REMOTE_NAME, USER_CONFIG, readUserConfig, writeUserConfig, looksLikeData, loadProjects, exists } from './lib/workbench.mjs';

const USAGE = `사용법: wb config get
       wb config set data-root <경로>
       wb config set workspace-root <경로>
       wb config set repo-path <논리 경로> <폴더>
       wb config set remote <원격 이름>
       wb config set board-autostart on|off
       wb config unset data-root | workspace-root | remote | board-autostart | repo-path <논리 경로>
  data-root       문서 저장소(board/, records/, projects.tsv가 있는 clone) 경로
                  우선순위: 환경변수 WORKBENCH_ROOT > 이 설정
  workspace-root  서비스 저장소들의 공통 상위 폴더 (그 아래 projects.tsv의 논리 경로대로 저장소가 있다)
                  우선순위: 환경변수 WORKSPACE_ROOT > 이 설정 > 문서 저장소의 상위 폴더
  repo-path       projects.tsv의 저장소 논리 경로(예: group/app)를 이 PC의 실제 폴더로 바꾼다
                  설정하지 않은 저장소는 {workspace-root}/{논리 경로}다
  remote          문서 저장소 clone의 git 원격 이름 (기본 origin)
  board-autostart on이면 Claude Code 세션이 시작될 때 보드를 백그라운드로 띄우고 브라우저를 연다.
                  이 PC의 세션이 모두 끝나면(터미널을 닫아도) 보드가 스스로 꺼진다. 기본 off
  설정 파일: ~/.workbench/config.json (PC별, 저장소 밖)`;

const KEYS = { 'data-root': 'dataRoot', 'workspace-root': 'workspaceRoot', 'repo-path': 'repoPaths', remote: 'remote', 'board-autostart': 'boardAutostart' };

/** 문서 저장소가 정해져 있으면 projects.tsv의 저장소 중 root 아래에 git 저장소로 있는 것 */
function describe(root, dataRoot = DATA.root) {
  if (!dataRoot || !exists(path.join(dataRoot, 'projects.tsv'))) return { root };
  const all = loadProjects(path.join(dataRoot, 'projects.tsv')).allRepos;
  const found = all.filter((r) => exists(path.join(REPO_PATHS[r] ?? path.join(root, r), '.git')));
  return { root, reposFound: found.length, reposMissing: all.filter((r) => !found.includes(r)) };
}
const reposLine = (d) => (d.reposFound === undefined ? '' : `  projects.tsv 저장소 ${d.reposFound}개가 보인다${d.reposMissing.length ? `, ${d.reposMissing.length}개는 이 PC에 없다: ${d.reposMissing.join(', ')}` : ''}`);

function requireDir(p, hint) {
  const abs = path.resolve(p);
  if (!exists(abs) || !fs.statSync(abs).isDirectory()) throw new Rejection({ code: 'CONFIG-PATH', message: `폴더가 없다: ${abs}`, fix: [hint] });
  return abs;
}
const normLogical = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');

run(async () => {
  const { positionals } = args({}, USAGE);
  const [op, key, ...values] = positionals;
  if (key && !KEYS[key]) throw usage(`알 수 없는 설정: ${key}. 있는 설정: ${Object.keys(KEYS).join(', ')}`, USAGE);
  const conf = readUserConfig();

  if (op === 'get') {
    const d = describe(WS);
    const repoPaths = conf.repoPaths ?? {};
    return {
      data: { file: USER_CONFIG, dataRoot: DATA.root, dataRootSource: DATA.source, workspaceRoot: WS, workspaceRootSource: WS_SOURCE, remote: REMOTE_NAME, repoPaths, boardAutostart: conf.boardAutostart === true, ...d },
      text: [
        `설정 파일: ${USER_CONFIG}${exists(USER_CONFIG) ? '' : ' (없음)'}`,
        `data-root: ${DATA.root ? `${DATA.root}  (${DATA.source})` : '(정해지지 않음 — set data-root <경로>로 설정한다)'}`,
        `workspace-root: ${WS}  (${WS_SOURCE})`,
        reposLine(d),
        `remote: ${REMOTE_NAME}${conf.remote ? '' : ' (기본값)'}`,
        `board-autostart: ${conf.boardAutostart === true ? 'on' : 'off'}${conf.boardAutostart === undefined ? ' (기본값)' : ''}`,
        ...Object.entries(repoPaths).map(([k, v]) => `repo-path: ${k} → ${v}`),
      ].filter(Boolean).join('\n'),
    };
  }

  if (op === 'set') {
    if (key === 'data-root' && values.length === 1) {
      const root = requireDir(values[0], '문서 저장소 clone 폴더의 경로를 확인해 다시 실행한다');
      if (!looksLikeData(root)) throw new Rejection({ code: 'CONFIG-NOT-DATA', message: `문서 저장소가 아니다(board/ 폴더가 없다): ${root}`, fix: ['board/, records/, projects.tsv가 있는 문서 저장소 clone의 경로를 준다'] });
      writeUserConfig({ ...conf, dataRoot: root });
      const notes = process.env.WORKBENCH_ROOT ? ['환경변수 WORKBENCH_ROOT가 설정되어 있어 이 설정보다 우선한다'] : [];
      return { data: { file: USER_CONFIG, dataRoot: root, notes }, text: [`설정: data-root = ${root} (${USER_CONFIG})`, ...notes.map((n) => `  참고: ${n}`)].join('\n') };
    }
    if (key === 'workspace-root' && values.length === 1) {
      const root = requireDir(values[0], '서비스 저장소들이 들어 있는 상위 폴더의 경로를 확인해 다시 실행한다');
      writeUserConfig({ ...conf, workspaceRoot: root });
      const d = describe(root);
      const notes = [];
      if (d.reposFound === 0) notes.push('projects.tsv의 저장소가 하나도 보이지 않는다. 경로가 맞는지 사용자에게 확인한다');
      if (process.env.WORKSPACE_ROOT) notes.push('환경변수 WORKSPACE_ROOT가 설정되어 있어 이 설정보다 우선한다');
      return { data: { file: USER_CONFIG, ...d, notes }, text: [`설정: workspace-root = ${root} (${USER_CONFIG})`, reposLine(d), ...notes.map((n) => `  참고: ${n}`)].filter(Boolean).join('\n') };
    }
    if (key === 'repo-path' && values.length === 2) {
      const logical = normLogical(values[0]);
      if (!logical || logical.startsWith('/') || /^[A-Za-z]:/.test(logical) || logical.split('/').includes('..')) throw usage(`논리 경로는 projects.tsv의 저장소 경로(예: group/app)다: ${values[0]}`, USAGE);
      const dir = requireDir(values[1], '저장소 폴더의 경로를 확인해 다시 실행한다');
      const notes = [];
      const tsv = DATA.root && path.join(DATA.root, 'projects.tsv');
      if (tsv && exists(tsv) && !loadProjects(tsv).allRepos.includes(logical)) notes.push(`projects.tsv에 없는 논리 경로다: ${logical}`);
      if (!exists(path.join(dir, '.git'))) notes.push(`git 저장소가 아니다: ${dir}`);
      writeUserConfig({ ...conf, repoPaths: { ...(conf.repoPaths ?? {}), [logical]: dir } });
      return { data: { file: USER_CONFIG, repo: logical, dir, notes }, text: [`설정: repo-path ${logical} → ${dir} (${USER_CONFIG})`, ...notes.map((n) => `  참고: ${n}`)].join('\n') };
    }
    if (key === 'remote' && values.length === 1) {
      if (!/^[A-Za-z0-9._-]+$/.test(values[0]) || values[0].startsWith('-')) throw usage(`원격 이름이 아니다: ${values[0]}`, USAGE);
      writeUserConfig({ ...conf, remote: values[0] });
      return { data: { file: USER_CONFIG, remote: values[0] }, text: `설정: remote = ${values[0]} (${USER_CONFIG})` };
    }
    if (key === 'board-autostart' && values.length === 1) {
      if (!['on', 'off'].includes(values[0])) throw usage(`board-autostart는 on 또는 off다: ${values[0]}`, USAGE);
      const on = values[0] === 'on';
      writeUserConfig({ ...conf, boardAutostart: on });
      const notes = on ? ['다음 Claude Code 세션부터 적용된다. 지금 띄우려면 wb board --open'] : ['이미 자동으로 뜬 보드는 세션이 모두 끝날 때 꺼진다. 지금 끄려면 wb board --stop'];
      return { data: { file: USER_CONFIG, boardAutostart: on, notes }, text: [`설정: board-autostart = ${values[0]} (${USER_CONFIG})`, ...notes.map((n) => `  참고: ${n}`)].join('\n') };
    }
    throw usage('set data-root <경로>, set workspace-root <경로>, set repo-path <논리 경로> <폴더>, set remote <이름>, set board-autostart on|off 중 하나로 쓴다', USAGE);
  }

  if (op === 'unset') {
    if (key === 'repo-path' && values.length === 1) {
      const logical = normLogical(values[0]);
      const { [logical]: had, ...rest } = conf.repoPaths ?? {};
      writeUserConfig({ ...conf, repoPaths: rest });
      return { data: { removed: had !== undefined }, text: had !== undefined ? `해제: repo-path ${logical}` : `변경 없음: repo-path ${logical}가 설정되어 있지 않다` };
    }
    if ((key === 'data-root' || key === 'workspace-root' || key === 'remote' || key === 'board-autostart') && !values.length) {
      const field = KEYS[key];
      const had = conf[field] !== undefined;
      writeUserConfig({ ...conf, [field]: undefined });
      return { data: { removed: had }, text: had ? `해제: ${key}` : `변경 없음: ${key}가 설정되어 있지 않다` };
    }
    throw usage('unset data-root, unset workspace-root, unset remote, unset board-autostart, unset repo-path <논리 경로> 중 하나로 쓴다', USAGE);
  }
  throw usage(`동작은 get, set, unset 중 하나다: ${op ?? '(없음)'}`, USAGE);
}, USAGE, { needsData: false });
