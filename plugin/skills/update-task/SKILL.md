---
name: update-task
description: workbench 보드 이슈를 사용자 지시로 고친다 — 컬럼 이동(다음 단계로, 완료, 폐기, 되돌리기)과 제목·본문·담당자·parent 수정, 그리고 main에 커밋·push까지. "CMN-11 design으로 옮겨줘", "이 이슈 완료 처리", "폐기해", "이슈 제목 바꿔", "본문에 이 내용 추가해" 같은 명시적 지시에만 쓴다. 이슈 생성은 new-task, 보관·꺼내기는 archive-task, 산출물 링크는 기록 스킬이 단다.
argument-hint: "{task_id 또는 제목} {바꿀 내용: 컬럼 id | 제목 | 담당자 | parent | 본문}"
allowed-tools: Bash(wb *), Read, Edit, Grep, Glob
---

# 이슈 수정

## 0. 규칙

[workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md)를 먼저 읽는다. 보드는 사용자가 지시한 범위만 고친다. 형식 세부는 [형식 규칙](${CLAUDE_PLUGIN_ROOT}/references/workbench-format.md)의 "이슈 파일"·"상태 규칙"이 정본이다.

## 1. 대상 찾기

`wb find-task <task_id | 제목> --json`. `ambiguous`면 후보를 보여 주고 묻는다. 없으면 만들지 말고 알린다. `archived: true`면 먼저 꺼내야 한다(archive-task).

## 2. 준비

`wb sync begin --files <이슈 파일>`. `SYNC-DIRTY-TARGET`이면 그 이슈에 사람이 고친 내용이 있다 — 섞지 말고 멈춰 알린다.

## 3. 고치기

| 지시 | 하는 법 |
|---|---|
| 컬럼 이동(완료·폐기 포함) | `wb move-task <task_id> <컬럼 id>`. 날짜와 history는 명령이 적는다. 컬럼은 이름이 아니라 id로 쓴다(clone의 `board/board.yml`). 끝나지 않은 child가 있어 거부되면 사용자에게 알리고, 사용자가 정했을 때만 `--force` |
| 제목·담당자·parent | 이슈 파일 프론트매터의 그 줄만 Edit으로 고친다. 필드 순서·따옴표는 그대로 둔다. parent는 한 단계만 허용한다 |
| 본문 | 프론트매터 아래 본문만 Edit으로 고친다. 사용자가 말한 내용만 쓴다 |
| `type`(유형) | 고치지 않는다. 이미 만든 브랜치 `{유형}/{task_id}`와 어긋난다. 유형이 다르면 새 이슈를 만들지 사용자에게 묻는다 |
| `task_id`·`created`·`history`·`outputs`·`archived` | 고치지 않는다(명령·다른 스킬이 관리한다) |

## 4. 검사와 커밋·push

1. `wb lint --files <이슈 파일>`. "누가"가 에이전트인 오류만 고친다
2. `wb sync commit --files <이슈 파일> --message "chore: <task_id> <바꾼 내용 요약> (<task_id>)"`

## 5. 보고

무엇을 어떻게 바꿨는지(예: `🔍 Discovery → 📐 Design`), 커밋, "다른 사람의 로컬 보드에는 다음 fetch 때(기본 30초) 보인다"을 알린다. 이슈가 종료 컬럼으로 갔으면 그 기록이 동결되었다는 것도 알린다.
