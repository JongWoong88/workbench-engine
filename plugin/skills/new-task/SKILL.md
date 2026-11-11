---
name: new-task
description: workbench 보드에 새 작업 이슈를 만든다 — task_id 발급, 이슈 파일 생성, 본문 정리, main에 커밋·push까지. 사용자가 "이슈 만들어줘", "이슈로 등록해", "보드에 올려줘", "하위 이슈 만들어"처럼 workbench 보드의 이슈 생성을 명시적으로 지시했을 때만 쓴다. 브랜치 번호만 필요하면 이슈를 만들지 않고 `wb next-task-id`를 쓴다. 이슈 수정·이동은 update-task, 보관은 archive-task.
argument-hint: "{제목} [project] [유형] [컬럼] [parent task_id] [본문으로 남길 내용]"
allowed-tools: Bash(wb *), Read, Write, Grep, Glob
---

# 이슈 생성

## 0. 규칙

[workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md)를 먼저 읽는다. 보드는 사용자가 지시했을 때만 고친다.

## 1. 입력 정리

| 항목 | 정하는 법 |
|---|---|
| project | 사용자가 말한 값 → 지금 작업 중인 저장소를 문서 저장소의 `projects.tsv`(`wb --help`의 `문서:` 경로)의 `repos`에서 찾은 값 → 여러 저장소·전사 공통이면 `common`. 그래도 모르면 묻는다. 표에 없는 저장소면 키를 만들지 말고 사용자에게 확인한다 |
| 유형 | `hotfix`, `feature`, `refact`, `improvement`, `research` 중 하나. 브랜치 `{유형}/{task_id}`가 된다. 요청에서 분명하지 않으면 묻는다 |
| 제목 | 한 줄. 같은 제목이 이미 있으면 명령이 거부한다 |
| 컬럼 | 말하지 않았으면 기본(`backlog`). 컬럼 id는 clone의 `board/board.yml` |
| parent | 하위 이슈면 상위 이슈의 task_id. 한 단계만 허용한다 |
| 본문 | 아래 3단계 |

## 2. 준비

`wb sync begin`을 부른다(새 파일이라 `--files` 없음). 거부되면 멈추고 사용자에게 알린다.

## 3. 본문 스캐폴딩

사용자가 준 내용만으로 본문을 정리해 임시 파일(세션의 scratchpad 폴더, 없으면 OS 임시 폴더 — 문서 저장소 안에는 두지 않는다)에 쓴다. 긴 본문을 명령 인자로 넘기지 않는다(셸이 따옴표·`%`·`&`를 깨뜨릴 수 있다). 기본 틀은 없다 — 사용자가 이슈 생성 뒤 직접 고친다.

- 사용자 지시의 배경, 제약, 요구사항, 관련 이슈를 마크다운 절로 나눈다. 사용자가 말하지 않은 내용을 지어내지 않는다
- 관련 이슈는 같은 폴더 상대 링크로 쓴다: `[CMN-8](CMN-8.md)`
- 내용이 없으면 본문 없이 만든다

## 4. 생성과 커밋·push

1. `wb new-task --project <project> --tag <유형> --title "<제목>" [--column <컬럼 id>] [--parent <task_id>] [--description-file <임시 파일>] --json`
   - 거부되면 `수정`·`누가`대로 한다. stderr에 `fetch 실패`가 있으면 번호가 겹칠 수 있다고 사용자에게 알린다
2. `wb sync commit --files <출력의 file> --message "chore: <제목> 이슈 등록 (<task_id>)"`
   - `SYNC-CONFLICT`면 다른 PC가 같은 번호를 먼저 썼을 수 있다. 번호 중복으로 보고하고 멈춘다

## 5. 보고

task_id, 이슈 파일, 컬럼, 브랜치명(`{유형}/{task_id}`), 커밋, "다른 사람의 로컬 보드에는 다음 fetch 때(기본 30초) 보인다"을 알린다.
