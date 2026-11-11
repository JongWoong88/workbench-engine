// 문서 저장소의 공유 설정 workbench.config.json. 팀이 함께 쓰는 값이라 문서 저장소에 커밋한다. 비밀을 넣지 않는다.
//   키를 모두 생략할 수 있다. 생략하면 엔진이 기본값을 쓴다(호환 규칙 K-2). 파일이 없어도 된다.
//   PC마다 다른 값(문서 저장소 위치, 저장소 폴더, git 원격 이름)은 PC별 설정(~/.workbench/config.json)에 둔다.
import path from 'node:path';
import { WB, read, exists } from './workbench.mjs';
import { Rejection, EXIT } from './report.mjs';

export const SHARED_CONFIG_FILE = 'workbench.config.json';
export const HOST_TYPES = ['gitlab', 'github'];
export const DEFAULT_DOC_ROOTS = ['src/main/resources/docs', 'docs'];
export const DEFAULTS = Object.freeze({ formatVersion: 1, branch: 'main', fetchIntervalSec: 30 });
/** 이 엔진이 아는 가장 높은 형식 버전. 깨지는 변경(K-5)이나 새 오류 규칙(K-3)을 낼 때 올린다 */
export const FORMAT_VERSION = 1;

/**
 * 호환 규칙 K-8: 문서 저장소가 이 엔진보다 새 형식이면 멈춘다. 자동 갱신을 끈 PC가 옛 엔진으로 남은 경우다.
 * 다른 키의 오류는 여기서 따지지 않는다(그 키를 쓰는 명령과 lint가 따진다)
 */
export function requireKnownFormat(root = WB) {
  const file = path.join(root, SHARED_CONFIG_FILE);
  if (!exists(file)) return;
  const { formatVersion } = parseSharedConfig(read(file)).config;
  if (formatVersion <= FORMAT_VERSION) return;
  throw new Rejection({
    code: 'ENV-FORMAT-NEWER', file: SHARED_CONFIG_FILE,
    message: '문서 저장소의 형식 버전(' + formatVersion + ')이 이 엔진이 아는 버전(' + FORMAT_VERSION + ')보다 높다. 엔진이 오래되었다',
    fix: ['workbench 플러그인을 갱신한다: claude plugin update workbench@<마켓플레이스> (열린 세션은 /reload-plugins)', '갱신할 수 없으면 사용자에게 알린다. 옛 엔진으로 이 문서 저장소를 고치지 않는다'],
    owner: 'user', exit: EXIT.ENV,
  });
}
const KNOWN = { formatVersion: 1, host: { type: 1, web: 1, api: 1 }, repo: 1, branch: 1, docRoots: 1, board: { fetchIntervalSec: 1 } };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const url = (v) => typeof v === 'string' && /^https?:\/\/[^\s/]+/.test(v);
const relPath = (v) => typeof v === 'string' && v.trim() !== '' && !path.isAbsolute(v) && !/^[A-Za-z]:/.test(v) && !v.replace(/\\/g, '/').split('/').includes('..');

/**
 * 파일 내용을 읽어 설정과 문제 목록을 돌려준다. 문제가 있어도 고칠 수 있는 키만 기본값으로 바꿔 설정을 만든다.
 * @return {{config: object, problems: {severity: 'error'|'warn', key: string, message: string}[]}}
 */
export function parseSharedConfig(text) {
  const problems = [];
  const bad = (key, message) => problems.push({ severity: 'error', key, message });
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { config: resolve({}), problems: [{ severity: 'error', key: '', message: `JSON으로 읽을 수 없다: ${e.message}` }] }; }
  if (!isObj(raw)) return { config: resolve({}), problems: [{ severity: 'error', key: '', message: '최상위 값이 객체가 아니다' }] };

  // 이 엔진이 모르는 키는 새 엔진이 더한 키이거나 오타다. 동작은 그대로 두고 알린다
  const unknown = (obj, known, prefix) => {
    for (const k of Object.keys(obj)) {
      if (!(k in known)) problems.push({ severity: 'warn', key: prefix + k, message: `이 엔진이 모르는 키다(오타이거나 더 새 엔진의 키): ${prefix}${k}` });
      else if (isObj(known[k]) && isObj(obj[k])) unknown(obj[k], known[k], `${prefix}${k}.`);
    }
  };
  unknown(raw, KNOWN, '');

  const v = {};
  if (raw.formatVersion !== undefined) {
    if (Number.isInteger(raw.formatVersion) && raw.formatVersion >= 1) v.formatVersion = raw.formatVersion;
    else bad('formatVersion', `formatVersion은 1 이상의 정수다: ${JSON.stringify(raw.formatVersion)}`);
  }
  if (raw.host !== undefined) {
    if (!isObj(raw.host)) bad('host', 'host는 객체다 ({"type": "gitlab"|"github", "web": "https://…"})');
    else {
      v.host = {};
      if (raw.host.type !== undefined) {
        if (HOST_TYPES.includes(raw.host.type)) v.host.type = raw.host.type;
        else bad('host.type', `host.type은 ${HOST_TYPES.join(' 또는 ')}다: ${JSON.stringify(raw.host.type)}`);
      }
      for (const k of ['web', 'api']) {
        if (raw.host[k] === undefined) continue;
        if (url(raw.host[k])) v.host[k] = raw.host[k].replace(/\/+$/, '');
        else bad(`host.${k}`, `host.${k}는 http(s) 주소다: ${JSON.stringify(raw.host[k])}`);
      }
      if (v.host.type === 'gitlab' && !v.host.web && !problems.some((p) => p.key === 'host.web')) bad('host.web', 'host.type이 gitlab이면 host.web(깃랩 서버 주소)이 필요하다');
    }
  }
  if (raw.repo !== undefined) {
    if (typeof raw.repo === 'string' && /^[^\s/]+(\/[^\s/]+)+$/.test(raw.repo)) v.repo = raw.repo;
    else bad('repo', `repo는 호스트의 문서 저장소 경로(예: group/docs)다: ${JSON.stringify(raw.repo)}`);
  }
  if (raw.branch !== undefined) {
    if (typeof raw.branch === 'string' && /^[^\s~^:?*[\\]+$/.test(raw.branch) && !raw.branch.startsWith('-')) v.branch = raw.branch;
    else bad('branch', `branch는 브랜치 이름이다: ${JSON.stringify(raw.branch)}`);
  }
  if (raw.docRoots !== undefined) {
    if (Array.isArray(raw.docRoots) && raw.docRoots.length && raw.docRoots.every(relPath)) v.docRoots = raw.docRoots.map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''));
    else bad('docRoots', 'docRoots는 저장소 안의 상대 경로 목록이다 (예: ["docs"])');
  }
  if (raw.board !== undefined) {
    if (!isObj(raw.board)) bad('board', 'board는 객체다 ({"fetchIntervalSec": 30})');
    else if (raw.board.fetchIntervalSec !== undefined) {
      if (Number.isInteger(raw.board.fetchIntervalSec) && raw.board.fetchIntervalSec >= 5) v.fetchIntervalSec = raw.board.fetchIntervalSec;
      else bad('board.fetchIntervalSec', `board.fetchIntervalSec는 5 이상의 정수(초)다: ${JSON.stringify(raw.board.fetchIntervalSec)}`);
    }
  }
  return { config: resolve(v), problems };
}

/** 검증한 값에 기본값을 채운다 */
function resolve(v) {
  const type = v.host?.type ?? null;
  const web = v.host?.web ?? (type === 'github' ? 'https://github.com' : null);
  const api = v.host?.api ?? (type === 'gitlab' && web ? `${web}/api/v4` : type === 'github' ? (web === 'https://github.com' ? 'https://api.github.com' : `${web}/api/v3`) : null);
  return {
    formatVersion: v.formatVersion ?? DEFAULTS.formatVersion,
    host: { type, web, api },
    repo: v.repo ?? null,
    branch: v.branch ?? DEFAULTS.branch,
    docRoots: v.docRoots ?? [...DEFAULT_DOC_ROOTS],
    board: { fetchIntervalSec: v.fetchIntervalSec ?? DEFAULTS.fetchIntervalSec },
  };
}

/**
 * 문서 저장소의 공유 설정. 파일이 없으면 기본값이다. 오류가 있으면 거부한다(경고는 lint가 알린다).
 * @return {ReturnType<typeof resolve> & {present: boolean}}
 */
export function loadSharedConfig(root = WB) {
  const file = path.join(root, SHARED_CONFIG_FILE);
  if (!exists(file)) return { ...resolve({}), present: false };
  const { config, problems } = parseSharedConfig(read(file));
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length) {
    throw new Rejection({
      code: 'CONFIG-SHARED', file: SHARED_CONFIG_FILE, message: `공유 설정 파일에 오류가 있다: ${errors.map((e) => e.message).join(' / ')}`,
      fix: [`${SHARED_CONFIG_FILE}을 고친다. 키는 모두 생략할 수 있다(생략하면 기본값)`, '팀이 함께 쓰는 파일이다. 고칠 값이 확실하지 않으면 사용자에게 확인한다'],
      owner: 'user',
    });
  }
  return { ...config, present: true };
}
