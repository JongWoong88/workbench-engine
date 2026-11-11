// 같은 PC에서 문서 저장소 clone의 git 조작을 한 번에 하나씩만 하게 하는 잠금.
// 여러 에이전트가 같은 clone으로 동시에 `wb sync`를 부르면 index.lock 충돌이나 남의 스테이징에 걸린다.
// 잠금 파일은 git 디렉터리 안(추적되지 않음)에 두고, 잡은 프로세스의 pid와 시각을 적는다.
//   - 잡은 프로세스가 죽었거나 STALE_MS가 지난 잠금은 낡은 것으로 보고 치운다
//   - 기다림이 WORKBENCH_SYNC_LOCK_TIMEOUT_MS(기본 120초)를 넘으면 SYNC-BUSY로 거부한다
import fs from 'node:fs';
import path from 'node:path';
import { Rejection, EXIT } from './report.mjs';
import { WB, git } from './workbench.mjs';

const STALE_MS = 10 * 60 * 1000;
const POLL_MS = 200;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // 다른 사용자의 프로세스면 살아 있다
  }
}

export function lockPath(root = WB) {
  const dir = git(['rev-parse', '--git-common-dir'], root).stdout.trim() || '.git';
  return path.resolve(root, dir, 'workbench-sync.lock');
}

/**
 * 잠금이 비어 있을 때만 잡고 fn을 실행한다. 다른 살아 있는 프로세스가 잡고 있으면 기다리지 않고 {skipped: true}.
 * 보드의 주기적 fetch처럼 이번 회차를 건너뛰어도 되는 작업에 쓴다
 */
export function tryWithLock(fn, { root = WB, label = 'try' } = {}) {
  const file = lockPath(root);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), label }), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 쓰는 중 */ }
      if (attempt === 0 && holder && (!alive(holder.pid) || Date.now() - holder.at > STALE_MS)) { fs.rmSync(file, { force: true }); continue; }
      return { skipped: true, holder };
    }
    try {
      return { skipped: false, value: fn() };
    } finally {
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true });
      } catch { /* 이미 없다 */ }
    }
  }
  return { skipped: true, holder: null };
}

/** 잠금을 잡고 fn을 실행한 뒤 푼다. fn의 반환값을 돌려준다 */
export function withLock(fn, { root = WB, label = 'sync' } = {}) {
  const file = lockPath(root);
  const timeout = Number(process.env.WORKBENCH_SYNC_LOCK_TIMEOUT_MS ?? 120_000);
  const start = Date.now();
  let holder = null;
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), label }), { flag: 'wx' });
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      holder = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      holder = null; // 쓰는 중이거나 깨진 파일이다. 다음 회차에 다시 본다
    }
    if (holder && (!alive(holder.pid) || Date.now() - holder.at > STALE_MS)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (Date.now() - start > timeout) {
      throw new Rejection({
        code: 'SYNC-BUSY',
        message: `다른 작업이 workbench git을 쓰고 있어 ${Math.round(timeout / 1000)}초 동안 기다렸지만 차례가 오지 않았다${holder ? ` (pid ${holder.pid}, ${holder.label})` : ''}`,
        fix: ['잠시 뒤 같은 명령을 다시 실행한다', `계속 막히면 잠금 파일(${file})을 잡은 프로세스가 멈춰 있는지 사용자에게 알린다. 파일을 직접 지우지 않는다`],
        exit: EXIT.ENV,
      });
    }
    sleep(POLL_MS);
  }
  try {
    return fn();
  } finally {
    try {
      const now = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now.pid === process.pid) fs.rmSync(file, { force: true });
    } catch { /* 이미 없다 */ }
  }
}
