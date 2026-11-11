// 스킬 프롬프트 템플릿과 이슈 팝업의 복사 버튼 노출 판정. DOM을 모르는 순수 함수다.
// 값은 해석·인용하지 않고 그대로 끼워 넣는다. Claude Code는 스킬 이름 뒤 문자열을 그대로 스킬에 넘기고,
// 뜻은 스킬 본문을 읽은 에이전트가 해석하기 때문이다

export const PLUGIN = 'workbench';
/** 템플릿이 부르는 스킬. 시험이 plugin/skills/{이름}/SKILL.md가 있는지 확인한다 */
export const SKILLS = ['update-task', 'archive-task', 'new-task'];
/** 폐기 컬럼. board.yml의 컬럼 id는 바꾸지 않는 값이다 */
export const DROP_COLUMN = 'dropped';

const call = (skill, args) => `/${PLUGIN}:${skill} ${args}`;

export const prompts = {
  move: (id, column) => call('update-task', `${id} ${column}`),
  drop: (id) => call('update-task', `${id} ${DROP_COLUMN}`),
  archive: (id) => call('archive-task', id),
  restore: (id) => call('archive-task', `${id} --restore`),
  /** 앞뒤 공백만 걷고 줄바꿈은 둔다. 비면 null */
  create: (text) => {
    const t = String(text ?? '').trim();
    return t ? call('new-task', t) : null;
  },
};

const stateOf = (board, id) => board.columns.find((c) => c.id === id)?.state;

/** 이동 옵션: 종료 컬럼과 현재 컬럼을 뺀 컬럼을 보드 순서대로 */
export function moveOptions(board, task) {
  return board.columns.filter((c) => c.state !== 'closed' && c.id !== task.column);
}

/**
 * 이슈 상태에 따라 보일 버튼. 스킬이 거부하거나 "변경 없음"으로 끝날 프롬프트는 만들지 않는다.
 * 보관된 이슈는 꺼내기만, 보관은 종료 컬럼의 이슈만 된다(CLAUDE.md 상태 규칙 S-5).
 * 끝나지 않은 하위 이슈가 있어도 폐기는 보인다 — 스킬이 그대로 폐기할지 묻는다.
 * @param {(id: string) => { closed: boolean } | undefined} taskById
 */
export function promptActions(task, board, taskById) {
  if (task.archived === true) return { move: false, drop: false, archive: false, restore: true, openChildren: 0 };
  const openChildren = (task.children ?? []).filter((id) => {
    const c = taskById(id);
    return c && !c.closed;
  }).length;
  return {
    move: moveOptions(board, task).length > 0,
    drop: board.columns.some((c) => c.id === DROP_COLUMN) && task.column !== DROP_COLUMN,
    archive: stateOf(board, task.column) === 'closed',
    restore: false,
    openChildren,
  };
}
