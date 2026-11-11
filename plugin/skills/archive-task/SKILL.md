---
name: archive-task
description: 종료된 workbench 보드 이슈를 보관하거나 보관한 이슈를 꺼낸다 — 그리고 main에 커밋·push까지. 사용자가 "이 이슈 보관해", "완료된 이슈들 아카이브", "보관한 이슈 다시 꺼내" 같이 명시적으로 지시했을 때만 쓴다. 완료·폐기 같은 컬럼 이동은 update-task.
argument-hint: "{task_id 또는 제목} [--restore]"
allowed-tools: Bash(wb *), Read, Grep, Glob
---

# 이슈 보관·꺼내기

## 0. 규칙

[workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md)를 먼저 읽는다.

## 1. 대상 찾기

`wb find-task <task_id | 제목> --json`. `ambiguous`면 묻는다. 여러 이슈를 보관하라는 지시면 대상 목록을 보여 주고 확인받는다.

- 보관은 종료 컬럼(`closed: true`)의 이슈만 된다. 진행 중이면 보관하지 말고, 먼저 완료·폐기할지 사용자에게 묻는다(update-task)
- 보관은 파일을 옮기지 않고 `archived: true`로 표시한다. 보관된 이슈는 사이트 기본 화면에서 빠지고 "보관 이슈 보기"로만 보인다

## 2. 준비

`wb sync begin --files <이슈 파일 …>`. 거부되면 멈추고 알린다.

## 3. 보관·꺼내기

이슈마다 `wb archive-task <task_id>`(꺼낼 때는 `--restore`).

## 4. 커밋·push

`wb sync commit --files <이슈 파일 …> --message "chore: <task_id 목록> 보관 (<대표 task_id>)"`(꺼낼 때는 "꺼냄").

## 5. 보고

보관·꺼낸 이슈 목록, 커밋, "다른 사람의 로컬 보드에는 다음 fetch 때(기본 30초) 보인다"을 알린다.
