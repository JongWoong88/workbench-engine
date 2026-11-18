// 훅들이 함께 쓰는 환경 읽기. 훅은 게시 패키지에서 hooks/ 폴더째 복사되고 cli/ 묶음을 쓰지 않으므로
// 이 파일은 Node 내장 모듈만 쓰고 plugin/cli/를 가져오지 않는다(설치물 규칙).
//   설정 폴더: 환경변수 WORKBENCH_CONFIG_DIR > ~/.workbench
//   문서 저장소: 환경변수 WORKBENCH_ROOT > PC별 설정 dataRoot. board/ 폴더가 있어야 문서 저장소로 본다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const configDir = () => path.resolve(process.env.WORKBENCH_CONFIG_DIR || path.join(os.homedir(), '.workbench'));

/** PC별 설정. 못 읽으면 빈 설정 */
export function userConfig(dir = configDir()) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

/** 문서 저장소 위치. 못 찾으면 null */
export function dataRoot(conf = userConfig()) {
  const root = process.env.WORKBENCH_ROOT || conf.dataRoot || null;
  return root && fs.existsSync(path.join(root, 'board')) ? path.resolve(root) : null;
}

/** projects.tsv의 key 열(주석 줄 제외)을 중복 없이 모은다. 읽지 못하면 빈 목록 */
export function taskIdKeys(file) {
  try {
    const keys = fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.split('\t')[1]?.trim())
      .filter((key) => key && key !== '-');
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

/** 세션 ID를 파일 이름으로 쓸 수 있게 바꾼다. 경로 문자는 모두 `_`가 된다 */
export const safeName = (sessionId) => String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';
