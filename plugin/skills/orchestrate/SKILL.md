---
name: orchestrate
description: workbench 보드 이슈 하나를 프롬프트 한 번으로 Planning(작업계획)까지 자율로 진행한다. 이슈 규모에 맞게 Discovery·Proposal·Design 중 필요한 단계만 고르고 작업계획은 반드시 쓴다. 단계 스킬(groundwork·plan)을 자율 모드로 차례로 실행하고, 결정은 멈추지 않고 이슈 폴더 decisions.md에 남기며, 컬럼을 단계에 맞춰 옮기고, 마지막에 담당자 평가를 요청한다. 담당자가 평가에서 수정한 결정이 있으면 다시 실행해 산출물을 재작성한다. "이 이슈 계획까지 진행해", "자동으로 진행해", "orchestrate" 같은 명시적 지시에만 쓴다. 단계 하나만 쓰려면 groundwork·plan, 평가 기록은 evaluate-decisions.
argument-hint: "{task_id 또는 이슈 제목} [요구사항·추가 프롬프트]"
allowed-tools: Skill, Agent, Read, Grep, Glob, Write, Edit, Bash
model: opus
---

이슈를 Planning까지 자율로 진행한다.

> $ARGUMENTS

## 0. 규칙

먼저 읽는다.

- 공통 규칙 [workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md). 특히 "보드" 2항의 `orchestrate` 이동 범위·절차
- 결정 기록 절차 [decision-recording.md](${CLAUDE_PLUGIN_ROOT}/references/decision-recording.md)와 형식 [decisions-format.md](${CLAUDE_PLUGIN_ROOT}/references/decisions-format.md)

지킬 것:

- 범위는 Planning까지다. 브랜치 생성, 코드 수정, child 이슈 생성, 종료 컬럼 이동은 하지 않는다(**반드시**).
- 사용자에게 결정을 묻지 않는다. 결정은 단계 스킬이 `decisions.md`에 기록한다. 멈추는 것은 [멈출 때](#멈출-때)뿐이다.
- 상태는 파일에 있다. 컬럼은 "지금 하는 단계", `decisions.md`의 `진행:` 줄은 "끝난 단계"다. 다시 실행하면 이 두 값으로 남은 일부터 한다.
- 단계 스킬은 이 세션에서 `Skill` 도구로 차례로 부른다. subagent에 맡기지 않는다. 단계 스킬이 띄우는 검토 subagent의 결과를 이 세션이 받아야 하기 때문이다.

## 1. 대상 확인

1. `wb find-task <입력> --json`. `ambiguous`면 후보를 보이고 멈춘다. 없으면 이슈를 만들지 말고, `new-task`로 먼저 만들라고 알린 뒤 멈춘다.
2. `closed: true`이거나 보관된 이슈면 멈춘다.
3. 컬럼이 `in-progress`이거나 Planning 뒤면 멈춘다. 이 스킬의 범위 밖이다.
4. 이슈 파일과 이슈 폴더에 커밋되지 않은 변경이 있으면 멈춘다: `git -C <workbench> status --porcelain -- board/tasks/<task_id>.md records/<project>/<task_id>/`. 사람이 고치던 내용이거나, 지난 실행이 커밋 전에 끊긴 흔적이다. 덮어쓰지 않는다.
5. 요구사항: 인자에서 이슈 지정 뒤의 글을 요구사항으로 쓴다. 없으면 이슈 본문을 요구사항으로 쓴다. 둘 다 비었으면 멈춘다.

## 2. decisions.md 준비

이슈 폴더에 `decisions.md`가 없으면 만든다.

1. `wb sync begin --files board/tasks/<task_id>.md`
2. `wb new-record --to <task_id> --name decisions.md --title "<이슈 제목> 결정 기록" --repos -`
3. 본문을 [형식](${CLAUDE_PLUGIN_ROOT}/references/decisions-format.md#구조)의 뼈대로 채운다: `평가 상태: 평가 전`, `진행: `(빈 값), `## 요약`(머리 행만), `## 상세`, `## 반영 기록`(머리 행만).
4. `wb link-output --task <task_id> --kind 결정 --path <decisions.md> --desc "agent 결정과 담당자 평가"`
5. `wb lint --files <decisions.md> <이슈 파일>` → `wb sync commit --files <decisions.md> <이슈 파일> --message "docs: <task_id> 결정 기록 시작 (<task_id>)"`

## 3. 단계 진행

단계 순서: `discovery` → `proposal` → `design` → `planning`. **`planning`(작업계획)은 반드시 쓴다.** 나머지 셋은 이슈 규모와 성격에 맞게 필요한 것만 쓴다. 네 단계를 모두 쓰는 것이 기본값이 아니다.

### 단계 고르기

시작할 때(그리고 단계 하나가 끝날 때마다 다시) 남은 단계 중 쓸 단계를 고른다. 진행 판단이라 `decisions.md`에 올리지 않는다.

| 단계 | 쓴다 | 건너뛴다(예) |
|---|---|---|
| discovery | 원인·현황을 코드·데이터로 확인해야 다음 판단을 할 수 있다. 영향 범위(다른 저장소가 읽는 값 등)를 모른다 | 요구사항과 대상 코드가 이슈 본문에 이미 분명하다. 문구·설정값 변경처럼 영향이 한 곳에 갇힌다 |
| proposal | 선택지가 둘 이상이고, 그 선택이 [기록 기준](${CLAUDE_PLUGIN_ROOT}/references/decisions-format.md#무엇을-결정으로-기록하는가)의 영향(사용자 동작·데이터·정책·다른 시스템·재발 위험)을 가른다 | 해법이 사실상 하나다. 갈리는 것이 구현 방식뿐이다 |
| design | 정책·규칙을 새로 정하거나, 구조·데이터 모델·연동 규격이 바뀐다 | 기존 구조 안의 국소 수정이다. 바뀌는 규칙을 계획서의 작업 설명으로 충분히 적을 수 있다 |
| planning | 항상 | — |

- 앞 단계 결과로 판단이 바뀌면 다시 고른다. 예: 건너뛰려던 proposal을, discovery에서 정책 선택지가 드러나 쓰게 된다.
- 건너뛴 단계에서 내렸을 결정은 다음에 쓰는 단계 문서가 맡는다. 예: proposal을 건너뛰고 planning에서 해법을 고르면, 그 선택이 기록 기준에 해당할 때 planning 단계 결정으로 `decisions.md`에 남긴다.
- discovery를 건너뛰어도 사실 확인은 생략하지 않는다. 다음 단계 스킬이 코드를 직접 읽고 근거를 붙인다.
- 건너뛴 단계와 이유는 이동 커밋 메시지와 [마무리 보고](#5-마무리-보고)에 적는다.

### 진행

```
진행 = decisions.md의 '진행:' 줄
쓸 단계 = 단계 고르기()                 # planning은 항상 포함
for 단계 in 순서:
    if 단계 in 진행: continue
    if 단계 not in 쓸 단계: 건너뜀 목록에 넣고 continue
    if 컬럼 != 단계: 이동(단계)          # 건너뛴 단계의 컬럼은 거치지 않는다
    단계 실행(단계)                      # 아래 표
    확인(단계)
    쓸 단계 = 단계 고르기()             # 남은 단계 다시 판단
    진행에 이 단계와 그 뒤 건너뛴 단계를 덧붙이고, 다음 단계로의 이동과 같은 커밋에 넣는다 (planning이면 단독 커밋)
```

- `진행:` 줄에는 끝낸 단계와 건너뛴 단계를 함께 컬럼 순서대로 적는다. 재개할 때 건너뛴 단계를 다시 하지 않기 위해서다. 시작 전에 건너뛴 단계(예: discovery)는 첫 이동 커밋에 넣는다.

**이동**: [workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md) "보드" 2항 절차대로 한다. `wb sync begin --files <이슈 파일> <decisions.md>` → (`진행:` 갱신) → `wb move-task <task_id> <단계>` → `wb lint --files <이슈 파일> <decisions.md>` → `wb sync commit --files <이슈 파일> <decisions.md> --message "chore: <task_id> <단계> 시작 (<task_id>)"`. 건너뛴 단계가 있으면 메시지 끝에 `— <단계> 건너뜀: <이유>`를 붙인다.

**단계 실행**: `Skill` 도구로 부른다. 인자 끝에 `--자율`을 **반드시** 붙인다.

| 단계 | 스킬 | 인자 |
|---|---|---|
| discovery | `workbench:groundwork` | `<task_id> 조사 <요구사항 요지> 요구사항 원문: <요구사항> --자율` |
| proposal | `workbench:groundwork` | `<task_id> 제안 <주제> --자율` |
| design | `workbench:groundwork` | `<task_id> 설계 <주제> --자율` |
| planning | `workbench:plan` | `작업명: <task_id> <이슈 제목>, 앞 단계 산출물 기준으로 계획 --자율` |

- 단계 스킬의 지시를 끝까지 따른다. 독립 검토 결과도 받아 반영하고, 커밋까지 마친 뒤 이 흐름으로 돌아온다.
- 앞 단계를 건너뛰었으면 인자의 "앞 단계 산출물" 대신 요구사항 원문을 넘긴다. 예: planning만 쓰면 `작업명: <task_id> <이슈 제목>, 요구사항 원문: <요구사항> --자율`.

**확인**: 단계 실행이 끝나면 아래를 본다. 하나라도 어긋나면 [멈출 때](#멈출-때)다.

- `wb find-task <task_id> --json`의 `outputs`에 이 단계의 산출물이 있다(건너뛴 단계는 제외)
- `wb decision-stats --task <task_id> --check`가 오류 0
- `git status`로 이슈 파일·이슈 폴더에 커밋되지 않은 변경이 없다

## 4. 재작성

모든 단계가 `진행:`에 있고, 담당자가 평가한 항목 중 **반영되지 않은 수정·누락**이 있으면 재작성한다. "반영되지 않음"은 그 항목의 상세 절에 `다시 만든 단계:` 줄이 없다는 뜻이다. `## 산출물 지적` 목록도 함께 반영한다. 반영한 지적 끝에 `(반영: <단계들>)`을 붙인다.

1. 대상 항목마다 다시 쓸 단계를 정한다: 그 항목의 `단계`부터 `planning`까지 중, 상세의 `근거 산출물:`이 가리키는 문서와 그 뒤 단계 문서.
2. 앞 단계부터 단계 스킬을 다시 부른다. 인자에 `--자율`과 함께 "`D-n` 평가 반영: <평가 내용>"을 넣는다. 단계 스킬은 같은 파일을 고친다.
3. 단계마다 그 항목 상세에 `다시 만든 단계: <단계들>`을 적는다. 컬럼과 `진행:` 줄은 되돌리지 않는다.
4. 재작성으로 새 `D-n`(평가 빈칸)이 생겼으면 `평가 상태:`를 `평가 전`으로 되돌린다.
5. 커밋은 단계 스킬이 한다. `decisions.md` 마지막 변경은 `wb sync commit --files <decisions.md> --message "docs: <task_id> 평가 반영 재작성 (<task_id>)"`.

## 5. 마무리 보고

- 단계별 산출물과 커밋
- `decisions.md` 요약 표를 영향도 순으로(상 → 중 → 하). 영향도 `상`은 결정할 것과 채택안을 그대로 보인다
- 건너뛴 단계와 이유, 재작성한 항목
- 다음 할 일: 담당자 평가 — `/workbench:evaluate-decisions <task_id>`로 대화로 평가하거나 `decisions.md`를 직접 고친다. 계획이 승인되면 child 이슈는 사용자 지시로 `new-task`가 만든다

## 멈출 때

아래면 그 자리에서 멈추고, 어디까지 커밋됐는지와 다시 실행할 명령(`/workbench:orchestrate <task_id>`)을 보고한다.

- 스크립트 거부의 `누가`가 "보드 수정"이나 "사용자 판단"이다(예: `SYNC-NOT-MAIN`, `SYNC-DIRTY-TARGET`, 동결된 이슈)
- 단계 스킬이 이슈 없음·동결 같은 이유로 작성을 거부했다
- 확인 항목이 어긋났다
- 이 세션의 컨텍스트가 부족해 다음 단계를 끝까지 하기 어렵다고 판단했다. 이때는 진행 중인 단계를 커밋까지 마친 뒤 멈춘다. 새 세션에서 같은 명령으로 이어 간다

멈춤을 피하려고 파일을 직접 쓰거나, `--force`·`--no-verify`를 쓰거나, 컬럼을 건너뛰지 않는다.
