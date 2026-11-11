// 이슈·기록 변경을 main에 커밋하고 push한다.
//   begin  쓰기 전: HEAD가 main인지 확인 → fetch → 원격이 앞서면 fast-forward → 대상 파일이 깨끗한지 확인
//   commit 쓴 뒤:   대상 밖 스테이징 없음 → 대상 경로 확인 → 대상 lint → fetch·fast-forward → 대상만 커밋(커밋 뒤 대상이 깨끗한지 확인) → push
//                   push가 거부되면 원격 끝 위에 로컬 커밋을 파일 단위로 다시 쌓아 한 번 더(작업 트리는 건드리지 않는다).
//                   같은 파일을 원격도 바꿨거나, 원격이 바꾼 파일에 미커밋 편집이 있으면 push하지 않고 멈춘다
//   같은 PC의 여러 에이전트가 이 clone을 함께 쓴다. bin/sync.mjs가 잠금(lib/lock.mjs) 안에서 부른다
// 에이전트는 이 모듈이 거부한 상태를 reset·rebase로 풀지 않는다. 거부 메시지대로 사용자에게 알린다.
import path from 'node:path';
import { rmSync } from 'node:fs';
import { Rejection, EXIT } from './report.mjs';
import { WB, REMOTE_NAME, git, posix, exists } from './workbench.mjs';
import { loadSharedConfig } from './shared-config.mjs';
import { lintRun } from './lint-run.mjs';

// 기본 브랜치는 문서 저장소의 공유 설정(branch, 기본 main), 원격 이름은 PC별 설정(remote, 기본 origin)이다.
// 설정 파일이 깨졌으면 모듈을 불러올 때가 아니라 begin·commit을 부를 때 거부한다
let sharedError = null;
const shared = (() => { try { return loadSharedConfig(); } catch (e) { sharedError = e; return loadSharedConfig(path.join(WB, '(none)')); } })();
export const MAIN = shared.branch;
export const REMOTE = REMOTE_NAME;
const requireConfig = () => { if (sharedError) throw sharedError; };

/** 리플레이 복제본처럼 원격이 없는 작업 공간에서는 동기화를 건너뛴다 */
export const skipped = () => process.env.WORKBENCH_SYNC === 'skip';
/** 원격 없이 로컬 커밋만 한다(fetch·push 없음). 복제본에서 커밋 단위를 그대로 남기고 싶을 때 */
export const localOnly = () => process.env.WORKBENCH_SYNC === 'local';

const g = (a, opts) => git(a, WB, { timeout: 120_000, ...opts });
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/** 인자로 받은 경로를 workbench 기준 상대경로로 */
export function toRel(files) {
  return files.map((p) => {
    const candidates = path.isAbsolute(p) ? [p] : [path.resolve(WB, p), path.resolve(p)];
    const abs = candidates.find((c) => exists(c)) ?? candidates[0];
    const r = posix(path.relative(WB, abs));
    if (r.startsWith('..') || path.isAbsolute(r)) {
      throw new Rejection({ code: 'SYNC-OUTSIDE', message: `workbench 밖의 파일이다: ${p}`, fix: ['workbench 안의 이슈·기록 파일만 지정한다'], exit: EXIT.USAGE });
    }
    return r;
  });
}

function requireMain() {
  const head = g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (head !== MAIN) {
    throw new Rejection({
      code: 'SYNC-NOT-MAIN', message: `문서 저장소 clone의 HEAD가 ${MAIN}이 아니다: ${head}`,
      fix: [`이슈·기록은 기본 브랜치(${MAIN})에만 커밋한다. 쓰기 전에 멈췄으므로 바뀐 파일은 없다`, `사용자에게 알린다. 사용자가 브랜치 작업을 마치고 \`git switch ${MAIN}\` 한 뒤 다시 실행한다`],
      owner: 'user',
    });
  }
}

function remoteFailure(r, what) {
  return new Rejection({
    code: 'SYNC-AUTH', message: `원격 ${what}에 실패했다: ${lines(r.stderr).slice(-2).join(' / ') || (r.timedOut ? '시간 초과' : '원인 불명')}`,
    fix: ['네트워크와 원격 저장소 자격 증명을 확인한다. 대화형 로그인이 필요하면 사용자가 터미널에서 `git fetch`로 한 번 로그인한다', '고친 뒤 같은 명령을 다시 실행한다'],
    owner: 'user', exit: EXIT.ENV,
  });
}

function fetch() {
  if (!g(['remote', 'get-url', REMOTE]).ok) {
    throw new Rejection({ code: 'SYNC-NO-REMOTE', message: `원격 '${REMOTE}'이 없다`, fix: ['원격에서 clone한 문서 저장소에서 실행한다. 원격 이름이 origin이 아니면 `wb config set remote <이름>`', '원격이 없는 복제본이면 WORKBENCH_SYNC=skip으로 동기화를 건너뛴다'], owner: 'user', exit: EXIT.ENV });
  }
  const r = g(['fetch', '--quiet', REMOTE, MAIN]);
  if (!r.ok) throw remoteFailure(r, 'fetch');
}

function aheadBehind() {
  const [ahead, behind] = g(['rev-list', '--left-right', '--count', `${MAIN}...${REMOTE}/${MAIN}`]).stdout.trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

/** 원격이 앞서면 fast-forward로 받는다. 갈라졌거나 로컬 편집과 겹치면 거부한다 */
function catchUp() {
  const { ahead, behind } = aheadBehind();
  if (behind && ahead) {
    const local = lines(g(['log', '--oneline', `${REMOTE}/${MAIN}..${MAIN}`]).stdout);
    throw new Rejection({
      code: 'SYNC-DIVERGED', message: `로컬 ${MAIN}과 원격이 갈라졌다 (로컬에만 ${ahead}개, 원격에만 ${behind}개)`,
      fix: [`로컬에만 있는 커밋: ${local.join(' | ')}`, '에이전트는 reset·rebase로 풀지 않는다. 사용자에게 알려 어느 쪽을 남길지 결정을 받는다', '같은 이슈 파일이 양쪽에 새로 생긴 경우는 task_id 중복이다. 번호 중복으로 보고한다'],
      owner: 'user',
    });
  }
  if (behind) {
    const r = g(['merge', '--ff-only', '--quiet', `${REMOTE}/${MAIN}`]);
    if (!r.ok) {
      throw new Rejection({
        code: 'SYNC-FF-BLOCKED', message: '원격 변경을 받지 못했다. 커밋하지 않은 로컬 편집이 원격 변경과 같은 파일을 건드린다',
        fix: [`git 출력: ${lines(r.stderr).slice(0, 4).join(' / ')}`, '그 편집은 사용자의 것일 수 있다. 덮어쓰거나 버리지 말고 사용자에게 알린다'],
        owner: 'user',
      });
    }
  }
  return { ahead, behind };
}

function statusOf(files) {
  return g(['status', '--porcelain', '--untracked-files=all', '--', ...files]).stdout.split('\n').filter(Boolean);
}

/**
 * 대상 경로를 `git add`에 넘길 것과 그렇지 않은 것으로 나눈다.
 * `git add -A -- <경로들>`은 작업 트리에도 인덱스에도 없는 경로가 하나라도 있으면 전체를 거부한다(아무것도 스테이징하지 않는다).
 * 미리 `git rm`으로 지운 파일이 그 경우다. 그런 경로는 HEAD에 있으면 이미 스테이징된 삭제로 보고 add에서 뺀다.
 * 어디에도 없는 경로는 missing으로 돌려준다(경로를 잘못 적었다)
 */
function stagePlan(targets) {
  const list = (args) => g([...args, '-z', '--', ...targets]).stdout.split('\0').filter(Boolean);
  const covers = (paths, t) => paths.some((p) => p === t || p.startsWith(`${t}/`));
  const inIndex = list(['ls-files']);
  const inHead = g(['rev-parse', '--verify', '-q', 'HEAD']).ok ? list(['ls-tree', '-r', '--name-only', 'HEAD']) : [];
  const add = [];
  const missing = [];
  for (const t of targets) {
    if (exists(path.join(WB, t)) || covers(inIndex, t)) add.push(t);
    else if (!covers(inHead, t)) missing.push(t);
  }
  return { add, missing };
}

/** 쓰기 전 점검. files를 주면 그 파일에 커밋 안 된 편집이 없어야 한다 */
export function begin({ files = [] } = {}) {
  if (skipped()) return { skipped: true };
  requireConfig();
  requireMain();
  const local = localOnly();
  const { behind } = local ? { behind: 0 } : (fetch(), catchUp());
  const targets = toRel(files);
  const dirty = targets.length ? statusOf(targets) : [];
  if (dirty.length) {
    throw new Rejection({
      code: 'SYNC-DIRTY-TARGET', message: `대상 파일에 커밋하지 않은 편집이 있다: ${dirty.map((l) => l.slice(3)).join(', ')}`,
      fix: ['스킬 밖에서 사람이 고친 내용일 수 있다. 섞어 커밋하지 않도록 쓰기 전에 멈췄다', '사용자에게 알려, 그 편집을 먼저 커밋할지 되돌릴지 결정을 받는다'],
      owner: 'user',
    });
  }
  return { skipped: false, local, pulled: behind };
}

function lint(targets) {
  const existing = targets.filter((t) => exists(path.join(WB, t)));
  if (!existing.length) return;
  // 같은 프로세스에서 검사한다(한 파일로 묶은 설치물에는 lint 명령 파일이 따로 없다)
  const r = lintRun({ mode: 'files', positionals: existing });
  if (r.exit === 0) return;
  const found = r.data.findings.filter((f) => f.severity === 'error');
  throw new Rejection({
    code: 'SYNC-LINT', message: `대상 파일이 workbench 규칙을 어긴다 (오류 ${found.length || '?'}건). 커밋하지 않았다`,
    fix: [...found.slice(0, 5).map((f) => `[${f.rule}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.message} → ${f.fix[0]}`), `전체: wb lint --files ${existing.join(' ')}`, '고친 뒤 sync commit을 다시 실행한다. "누가"가 사용자인 항목은 보고한다'],
  });
}

/**
 * CI lint 안전망을 건너뛰어도 되는지 끝 커밋 메시지에 표시한다(트레일러 LINT_TRAILER).
 * push할 트리와 검사한 트리가 같아야 하므로, 이번에 만든 커밋이 끝 커밋이고 작업 트리가 깨끗할 때만 `lint --all`을 돌려 붙인다.
 * 그 밖의 경우(검사 실패 포함)는 떼서 CI가 검사하게 둔다. rebase로 트리가 바뀌면 다시 부른다
 */
export const LINT_TRAILER = 'Workbench-Lint: all-passed';
function markLint(ownTip) {
  const message = g(['log', '-1', '--format=%B']).stdout.replace(/\s+$/, '');
  const kept = message.split('\n').filter((l) => l.trim() !== LINT_TRAILER).join('\n').replace(/\s+$/, '');
  const passed = ownTip && !g(['status', '--porcelain']).stdout.trim()
    && lintRun({ mode: 'all' }).exit === 0;
  // 메시지만 바꾼다. 스테이징이 비어 있어 pre-commit은 검사할 파일이 없다
  const amend = (extra) => g(['commit', '--amend', '-q', '-F', '-', ...extra], { input: `${kept}\n` });
  if (passed) amend(['--trailer', LINT_TRAILER]);
  else if (kept !== message) amend([]);
}

function push(ref = MAIN) {
  return g(['push', '--quiet', REMOTE, `${ref}:refs/heads/${MAIN}`]);
}

const rejectedPush = (r) => /rejected|non-fast-forward|fetch first/i.test(r.stderr);

/** 대상 파일만 커밋하고 push한다. message는 받은 그대로 쓴다 */
export function commit({ files, message }) {
  if (skipped()) return { skipped: true };
  requireConfig();
  const targets = toRel(files);
  requireMain();

  const staged = g(['diff', '--cached', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
  // 대상이 폴더면 그 아래 파일(미리 git rm한 삭제 포함)도 대상이다
  const other = staged.filter((f) => !targets.some((t) => f === t || f.startsWith(`${t.replace(/\/+$/, '')}/`)));
  if (other.length) {
    throw new Rejection({
      code: 'SYNC-STAGED-OTHER', message: `대상 밖 파일이 스테이징돼 있다: ${other.join(', ')}`,
      fix: ['남의 변경을 섞어 커밋하지 않도록 멈췄다', '사용자에게 알려, 그 스테이징을 먼저 커밋할지 내릴지(`git restore --staged`) 결정을 받는다'],
      owner: 'user',
    });
  }
  const plan = stagePlan(targets);
  if (plan.missing.length) {
    throw new Rejection({
      code: 'SYNC-NO-TARGET', message: `대상 경로가 작업 트리에도 인덱스에도 HEAD에도 없다: ${plan.missing.join(', ')}`,
      fix: ['경로를 잘못 적었는지 확인해 고친다. 커밋하지 않았고 스테이징도 그대로다', '새로 만들 파일이면 파일을 만든 뒤 다시 실행한다'],
      exit: EXIT.USAGE,
    });
  }
  lint(targets);
  const local = localOnly();
  if (!local) {
    fetch();
    catchUp();
  }

  let sha = null;
  if (statusOf(targets).length) {
    const unstage = () => { if (plan.add.length) g(['restore', '--staged', '--', ...plan.add]); };
    const a = plan.add.length ? g(['add', '-A', '--', ...plan.add]) : { ok: true };
    if (!a.ok) {
      unstage();
      throw new Rejection({
        code: 'SYNC-ADD-FAILED', message: '대상 파일을 스테이징하지 못했다. 커밋하지 않았다',
        fix: [`git 출력: ${lines(a.stderr).slice(0, 4).join(' / ') || '없음'}`, '출력의 원인(경로, 권한, 잠긴 index.lock 등)을 고친 뒤 sync commit을 다시 실행한다. 원인을 알 수 없으면 사용자에게 알린다'],
        owner: 'user',
      });
    }
    const c = g(['commit', '-q', '-F', '-'], { input: message });
    if (!c.ok) {
      unstage();
      throw new Rejection({
        code: 'SYNC-LINT', message: '커밋이 거부되었다 (pre-commit)',
        fix: [...lines(c.stdout + '\n' + c.stderr).slice(0, 8), '위 출력대로 고친 뒤 sync commit을 다시 실행한다. hook을 우회하지 않는다'],
      });
    }
    sha = g(['rev-parse', '--short', 'HEAD']).stdout.trim();
    const left = statusOf(targets);
    if (left.length) {
      throw new Rejection({
        code: 'SYNC-INCOMPLETE', message: `커밋 ${sha}에 대상 파일의 변경이 다 들어가지 않았다. push하지 않았다: ${left.map((l) => l.slice(3)).join(', ')}`,
        fix: [`커밋 ${sha}은 로컬 main에만 있다. 남은 변경을 누가 만들었는지(다른 에이전트, hook, 사람) 확인한다`, '사용자에게 알려, 남은 변경을 이어 커밋할지(sync commit을 같은 대상으로 다시 실행) 버릴지 결정을 받는다. reset으로 커밋을 되돌리지 않는다'],
        owner: 'user',
      });
    }
  }
  if (local) return { skipped: false, local: true, committed: sha, pushed: false, retried: false };
  if (!sha && !aheadBehind().ahead) return { skipped: false, committed: null, pushed: false, retried: false };

  markLint(Boolean(sha));
  if (sha) sha = g(['rev-parse', '--short', 'HEAD']).stdout.trim();
  let p = push();
  let retried = false;
  if (!p.ok && rejectedPush(p)) {
    // 원격이 먼저 바뀌었다. 작업 트리는 같은 PC의 다른 에이전트와 함께 쓰므로 rebase·stash로 건드리지 않는다.
    // 원격 끝 위에 로컬에만 있는 커밋을 파일 단위로 다시 쌓아 push하고, 성공하면 로컬 main을 그 커밋으로 옮긴다
    retried = true;
    fetch();
    const { tip, remoteChanged } = replayOnRemote(sha);
    p = push(tip);
    if (p.ok) {
      adoptTip(tip, remoteChanged);
      sha = g(['rev-parse', '--short', 'HEAD']).stdout.trim();
    }
  }
  if (!p.ok) {
    if (rejectedPush(p)) {
      throw new Rejection({ code: 'SYNC-CONFLICT', message: `다시 올린 뒤에도 push가 거부되었다(다른 PC가 계속 push 중). 로컬 커밋 ${sha}은 남아 있다`, fix: ['잠시 뒤 sync commit을 같은 인자로 다시 실행한다', '계속 거부되면 사용자에게 알린다'], owner: 'user' });
    }
    throw remoteFailure(p, 'push');
  }
  return { skipped: false, committed: sha, pushed: true, retried };
}

/** a→b 사이에 바뀐 파일과 상태(A·M·D). 이름 바꾸기는 지우기+추가로 본다 */
function changedPaths(a, b) {
  const out = g(['diff-tree', '-r', '--no-commit-id', '--no-renames', '--name-status', '-z', a, b]).stdout.split('\0').filter(Boolean);
  const map = new Map();
  for (let i = 0; i + 1 < out.length; i += 2) map.set(out[i + 1], out[i][0]);
  return map;
}

/**
 * 원격 끝 위에 로컬에만 있는 커밋을 다시 쌓은 커밋을 만든다. 작업 트리·index·로컬 ref는 바꾸지 않는다(임시 index를 쓴다).
 * - 로컬 커밋이 바꾼 파일을 원격도 바꿨으면 거부한다. 내용을 병합하지 않는다
 * - 원격이 바꾼 파일에 커밋 안 된 편집이 있으면 거부한다. 성공 뒤 그 파일을 작업 트리에 반영할 수 없기 때문이다
 */
function replayOnRemote(sha) {
  const remote = `${REMOTE}/${MAIN}`;
  const base = g(['merge-base', MAIN, remote]).stdout.trim();
  const remoteChanged = changedPaths(base, remote);
  const commits = lines(g(['rev-list', '--reverse', `${remote}..${MAIN}`]).stdout);
  const overlap = [...new Set(commits.flatMap((c) => [...changedPaths(`${c}^`, c).keys()]))].filter((f) => remoteChanged.has(f));
  if (overlap.length) {
    throw new Rejection({
      code: 'SYNC-CONFLICT', message: `push가 거부되어 원격 변경 위에 다시 올리려 했으나, 같은 파일을 원격도 바꿨다. 로컬 커밋 ${sha ?? ''}은 남아 있고 push하지 않았다`,
      fix: [`겹친 파일: ${overlap.join(', ')}`, '에이전트는 reset·rebase로 풀지 않는다. 사용자에게 알려 결정을 받는다', '같은 이슈 파일이 양쪽에 새로 생긴 경우는 task_id 중복이다. 번호 중복으로 보고한다'],
      owner: 'user',
    });
  }
  const dirty = remoteChanged.size ? statusOf([...remoteChanged.keys()]) : [];
  if (dirty.length) {
    throw new Rejection({
      code: 'SYNC-FF-BLOCKED', message: `push가 거부되어 원격 변경 위에 다시 올리려 했으나, 원격이 바꾼 파일에 커밋하지 않은 로컬 편집이 있다. 로컬 커밋 ${sha ?? ''}은 남아 있고 push하지 않았다`,
      fix: [`편집이 있는 파일: ${dirty.map((l) => l.slice(3)).join(', ')}`, '그 편집은 사용자나 다른 에이전트의 것일 수 있다. 덮어쓰거나 버리지 말고 사용자에게 알린다'],
      owner: 'user',
    });
  }

  const gitDir = path.resolve(WB, g(['rev-parse', '--git-dir']).stdout.trim());
  const env = { ...process.env, GIT_INDEX_FILE: path.join(gitDir, `workbench-sync-index-${process.pid}`) };
  let tip = g(['rev-parse', remote]).stdout.trim();
  try {
    for (const c of commits) {
      g(['read-tree', tip], { env });
      for (const [f, st] of changedPaths(`${c}^`, c)) {
        if (st === 'D') g(['update-index', '--force-remove', '--', f], { env });
        else {
          const [mode, , blob] = g(['ls-tree', c, '--', f]).stdout.trim().split(/\s+/);
          g(['update-index', '--add', '--cacheinfo', `${mode},${blob},${f}`], { env });
        }
      }
      const tree = g(['write-tree'], { env }).stdout.trim();
      const [an, ae, ad] = g(['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', c]).stdout.trim().split('\0');
      // 트리가 원격 변경과 합쳐져 달라졌으므로 lint 트레일러는 떼고 CI가 검사하게 둔다
      const msg = g(['log', '-1', '--format=%B', c]).stdout.split('\n').filter((l) => l.trim() !== LINT_TRAILER).join('\n').replace(/\s+$/, '');
      const made = g(['commit-tree', tree, '-p', tip, '-F', '-'], { input: `${msg}\n`, env: { ...env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad } });
      if (!made.ok) throw new Error(`commit-tree 실패: ${made.stderr}`);
      tip = made.stdout.trim();
    }
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
  }
  return { tip, remoteChanged };
}

/** push한 커밋으로 로컬 main을 옮기고, 원격이 바꾼 파일만 index·작업 트리에 반영한다. 다른 파일과 남의 편집은 건드리지 않는다 */
function adoptTip(tip, remoteChanged) {
  const old = g(['rev-parse', MAIN]).stdout.trim();
  g(['update-ref', `refs/heads/${MAIN}`, tip, old]);
  const removed = [...remoteChanged].filter(([, st]) => st === 'D').map(([f]) => f);
  const updated = [...remoteChanged].filter(([, st]) => st !== 'D').map(([f]) => f);
  if (updated.length) g(['checkout', tip, '--', ...updated]);
  if (removed.length) g(['rm', '-q', '--ignore-unmatch', '--', ...removed]);
}
