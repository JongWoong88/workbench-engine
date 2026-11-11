---
name: evaluate-decisions
description: workbench 이슈 폴더 decisions.md에 담당자 평가(승인·수정·누락·제외, 영향도 수정)를 기록하고 지표를 보여 준 뒤 main에 커밋·push한다. 담당자가 대화로 평가하면 대신 적고, 담당자가 파일을 직접 고쳤으면 형식 확인과 집계만 하고 마감한다. "CMN-20 결정 평가할게", "D-3은 수정, D-5는 승인", "평가 마감해", "결정 기록 평가 끝났어" 같은 요청에 쓴다. 결정을 기록하는 일은 단계 스킬과 orchestrate, 평가를 반영한 재작성은 orchestrate.
argument-hint: "{task_id} [평가 내용 — 예: D-2 수정: …, D-4 승인, 누락: …] [마감]"
allowed-tools: Bash(wb *), Bash(git *), Read, Edit, Grep, Glob
---

`decisions.md`에 담당자 평가를 기록한다.

> $ARGUMENTS

## 0. 규칙

- [workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md)와 형식 [decisions-format.md](${CLAUDE_PLUGIN_ROOT}/references/decisions-format.md)를 먼저 읽는다.
- 평가는 담당자의 판단이다. 담당자가 말하지 않은 항목을 대신 평가하지 않는다(**반드시**). 평가 값이나 영향도를 추측해 채우지 않는다.
- 하네스(스킬·규칙·워크플로·이슈 스키마)은 이 스킬이 고치지 않는다. 원인을 분류해 제안하고, 반영 여부는 담당자가 정한다.

## 1. 대상 확인

1. `wb find-task <task_id> --json`. 이슈 폴더에 `decisions.md`가 없으면 멈추고 알린다.
2. 경로를 고른다: `git -C <workbench> status --porcelain -- <decisions.md>`
   - 변경 없음 → **경로 1 대화 평가**
   - 변경 있음(담당자가 직접 고침) → **경로 2 직접 편집 후 마감**. 사람의 편집을 덮어쓰지 않는다

## 2. 경로 1 — 대화 평가

1. `wb sync begin --files <decisions.md>`
2. 평가할 항목을 영향도 순(상 → 중, 예전 기록의 하는 마지막)으로 요약 표 그대로 보여 준다. 평가 값([평가 값](${CLAUDE_PLUGIN_ROOT}/references/decisions-format.md#평가-값))을 함께 안내한다. 인자에 평가 내용이 있으면 그것부터 적용한다.
3. 담당자가 말한 대로 기록한다. 요약 표 `평가` 열과 상세 `평가:` 줄을 **둘 다** 쓴다. 집계는 요약 표만 읽는다.
   - 요약 표 `평가` 열: `승인`·`수정`·`제외(불필요)`·`제외(판정 불가)`
   - 상세 `평가:` 줄: `<평가 값> · <평가자> · <날짜>`. `수정`이면 `—` 뒤에 바뀐 내용, `제외`면 이유
   - 담당자가 "결정할 일이 아니다", "평가 대상이 아니다"라고 하면 `제외(불필요)`, "판단할 수 없다(환경 탓)"면 `제외(판정 불가)`다. 어느 쪽인지 애매하면 묻는다
   - 영향도를 바꾸라고 하면 요약 표 `영향도`를 `중→상`처럼 적는다
   - **누락**: 담당자에게 올렸어야 할 **결정**만 누락이다. 새 `D-n`(다음 번호)을 만든다. 요약 표에 `평가 = 누락`, `채택안`은 비우고, `하네스`는 같은 단계 다른 항목의 값(없으면 `—`)을 적는다. 상세 `평가:` 줄에 정했어야 할 내용을 적는다
   - **산출물 지적**: 설계 결함·조사 누락처럼 결정이 아닌 지적은 관련 `D-n`이 있으면 그 항목의 `수정`으로, 없으면 `## 산출물 지적`에 산출물 위치와 함께 적는다
4. `수정`·`누락` 항목마다 원인을 분류해 제안한다(형식의 [반영 기록](${CLAUDE_PLUGIN_ROOT}/references/decisions-format.md#반영-기록) 원인 표). `제외(불필요)`가 같은 유형으로 반복되면 그 유형도 한 행으로 제안한다(기록 기준을 고칠 근거). 담당자의 답대로 `## 반영 기록`에 행을 적는다. 지금 고치지 않으면 `반영 예정 — <무엇을>` 또는 `반영하지 않음 — <이유>`다.
5. 평가 빈칸이 하나도 없으면 `평가 상태:`를 `평가 완료 (<날짜>, <평가자>)`로 바꾼다. 빈칸이 남았으면 `평가 전`으로 둔다.
6. `wb decision-stats --task <task_id> --check`. 오류는 형식만 고치고(내용은 담당자에게 묻는다) 다시 실행한다.
7. `wb lint --files <decisions.md>` → `wb sync commit --files <decisions.md> --message "docs: <task_id> 결정 평가 (<task_id>)"`

## 3. 경로 2 — 직접 편집 후 마감

`wb sync begin`을 부르지 않는다. 대상 파일이 바뀌어 있어 `SYNC-DIRTY-TARGET`으로 거부되기 때문이다.

1. `wb decision-stats --task <task_id> --check`. 오류가 있으면 고치지 말고 위치와 내용을 담당자에게 보이고 멈춘다. 담당자가 고친 뒤 다시 요청한다.
2. 평가 빈칸이 없는데 `평가 상태:`가 `평가 전`이면, 담당자에게 확인받아 `평가 완료`로 바꾼다.
3. `수정`·`누락` 중 `## 반영 기록`에 행이 없는 항목을 알리고, 경로 1의 4번처럼 원인을 묻는다.
4. `wb lint --files <decisions.md>` → `wb sync commit --files <decisions.md> --message "docs: <task_id> 결정 평가 (<task_id>)"`. `sync commit`이 원격 변경 때문에 거부하면 멈추고 알린다.

## 4. 보고

- `wb decision-stats --task <task_id>` 결과(평가 완료일 때). 평가 전이면 남은 빈칸 수
- 반영 기록 중 `반영 예정` 항목
- 다음 할 일:
  - 반영되지 않은 수정·누락·산출물 지적이 있으면 `/workbench:orchestrate <task_id>`를 다시 실행해 산출물을 재작성한다
  - 계획이 승인됐으면 child 이슈를 만들지 담당자에게 묻는다(만드는 것은 `new-task`)
