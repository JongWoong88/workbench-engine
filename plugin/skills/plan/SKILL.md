---
name: plan
description: workbench 작업 공간의 작업(보드 이슈)에 대한 작업 계획서를 세워 records에 남긴다 — Sub-Task 식별·순서·테스트 계획, 이슈 산출물 링크, main에 커밋·push까지. "작업 계획 세워줘", "계획서 써줘" 같은 요청에 쓴다. 조사·제안·설계 문서는 /workbench:groundwork.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash, Agent
argument-hint: "작업명: {작업명}, 추가적인 프롬프트 [--자율]"
model: opus
---

작업에 대한 계획을 수립하고 문서로 작성

> $ARGUMENTS

인자에 `--자율` 플래그가 있으면 **자율 모드**, 없으면 수동 모드다. 이슈가 있으면 두 모드 모두 계획을 세우며 내린 결정을 `decisions.md`에 남긴다. 절차와 자율 모드에서 바뀌는 규칙은 [decision-recording.md](${CLAUDE_PLUGIN_ROOT}/references/decision-recording.md)를 따른다.

# 목표

- 주어진 작업을 완료하기 위한 작은 단위 작업(Sub-Task) 식별
- Sub-Task의 작업 우선 순위 및 Type 부여
- 다른 개발자가 참조하여 작업을 할 수 있는 계획을 수립하고 문서화

# 워크플로우

1. 작업을 완료하기 위한 관련 설계 문서와 작업 이슈 확인 — 설계·업무 문서는 공통 규칙 [workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md)의 "참조할 지식과 문서" 순서로 찾는다
   - 공통 규칙 [workbench-rules.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-rules.md)를 먼저 읽는다
   - [기록 공간](#저장-위치)이 있으면 `wb find-task <task_id | 작업명>`으로 이슈를 찾고, 이슈의 산출물 목록(`outputs` — 조사·제안·설계 기록)을 먼저 읽는다
2. 작업 계획 수립
   1. 하위 작업(Sub-Task) 파악. 기능의 단위는 **TDD 원칙**에 따른 커밋 가능한 단위
   2. 각 Task의 Type을 부여
   3. Task의 순서를 정한다. 도메인 > 데이터 > 응용/인프라 > 표현 계층 순으로 구현
   4. 쓰기 전에 `wb sync begin [--files <고칠 기존 계획서> <기존 decisions.md>]`을 부른다(새 파일은 넣지 않는다). 거부되면 멈추고 알린다. `decisions.md`가 있으면 `planning` 단계 항목을 먼저 읽는다
   5. 계획서를 [저장 위치](#저장-위치)에 Markdown으로 작성. Sub-Task 분할·순서·범위에서 고른 것은 `decisions.md`에 `D-n`(단계 `planning`)으로 기록하고 계획서에는 `D-n` 링크만 단다
3. 이슈가 있으면 **결정 누락** 검토자를 반드시 띄운다([decision-review.md](${CLAUDE_PLUGIN_ROOT}/references/decision-review.md), 단계 `planning`). 아래 선택 검토자가 있으면 한 메시지에서 함께 띄운다. 채택한 지적은 `decisions.md`에 `D-n`으로 추가한다
   - (Optional) 아래 사항에 해당하는 경우 각 필요에 따른 `workbench:plan-reviewer` 에이전트(`subagent_type: workbench:plan-reviewer`)를 병렬로 호출하여 작업 계획 적합성에 대한 검토
     - 계획 검토가 필요하지 않은 예: 단순 문서작업, DB 스키마 변경 작업 등
     - 설계 변경이 수반되는 작업: 변경될 설계가 적합한지를 중점적으로 검토할 에이전트 호출
     - 횡단관심사(예외/보안 등) 관련 작업: 기존 구현 변경 또는 새로운 구현 추가시 기능에 미칠 영향을 중점적으로 검토할 에이전트 호출
     - 비즈니스 로직 변경 작업: 기존 구현과 기획 문서를 참고하여 변경될 비즈니스 로직이 적합한지 검토할 에이전트 호출
4. 산출물 링크 추가
   - 1단계에서 찾은 이슈가 있으면 `wb link-output --task <task_id> --kind 작업계획 --path <계획서> --desc "<한 줄 설명>"`으로 이슈 산출물(`outputs`)에 링크를 단다
   - 워크스페이스 규칙상 보드에서 허용된 수정은 이 링크 추가뿐이다. Sub-tasks·컬럼·Relations는 사용자가 지시한 경우에만 바꾼다
   - `decisions.md`를 이번에 만들었으면 `wb link-output --task <task_id> --kind 결정 --path <decisions.md> --desc "agent 결정과 담당자 평가"`. 결정을 기록했으면 `wb decision-stats --task <task_id> --check`로 형식을 확인한다
   - `wb lint --files <계획서> <decisions.md> <이슈 파일>`로 검사한다
   - `wb sync commit --files <계획서> <decisions.md> <이슈 파일> --message "docs: <계획서 제목> (<task_id>)"`로 커밋·push하고, 어느 이슈에 어떤 링크를 넣었는지와 이번에 추가·수정한 `D-n`(영향도 순)을 보고한다

# 저장 위치

계획서는 특정 시점의 **작업·기록 문서**다. 저장소가 아니라 작업 공간(`records/`)에 둔다. 서비스 저장소의 문서 폴더에는 쓰지 않는다 — 그곳은 `/workbench:documentation`이 다루는 현황 문서 자리다.

| 경우 | 저장 경로 |
|---|---|
| 관련 이슈가 있음 | `records/{project}/{task_id}/plan-<주제>.md` |
| 관련 이슈가 없음 | `records/{project}/plan-<주제>.md` |

1. 문서 저장소(이슈·기록이 있는 clone)의 위치는 `wb --help`의 `문서:` 줄이다. `wb`가 없으면(workbench 플러그인 미설치) 작성하지 말고 사용자에게 알린다. 폴더 구조·`project` 값·링크 형식의 정본은 [형식 규칙](${CLAUDE_PLUGIN_ROOT}/references/workbench-format.md)다
2. 이슈는 `wb find-task <task_id | 작업명>`으로 찾는다. `status: ambiguous`면 사용자에게 묻는다. `closed: true`(종료·동결)인 이슈에는 계획서를 만들 수 없다
3. 계획서 파일은 `wb new-record --to <task_id | project> --name plan-<주제>.md --title <제목> [--repos <저장소,…>]`로 만들고 본문을 쓴다. 저장소가 없는 project(`common` 등)이거나 근거 저장소가 없으면 `--repos -`. 위치와 프론트매터(`base` 포함)는 스크립트가 채운다. 이슈가 없으면 `--to`에 문서 저장소의 `projects.tsv`(`wb --help`의 `문서:` 경로)의 project 값을 주고, 이슈 없이 두었다고 알린다
4. 계획서에서 저장소 문서·코드를 참조할 때는 계획서 파일 기준 상대경로로 링크한다 (이슈 폴더의 계획서라면 `../../../../{워크스페이스 폴더}/{저장소}/{경로}`, 이슈 없는 계획서라면 `../../../{워크스페이스 폴더}/{저장소}/{경로}` — 문서 저장소의 상위 폴더를 워크스페이스 루트로 보고 `projects.tsv`의 논리 경로를 쓴다). 반대로 저장소 문서에서 계획서를 링크하지 않는다
5. 스크립트가 거부하면(종료 코드 1·2) 출력의 `수정`대로 고치고 `확인` 명령으로 다시 실행한다. `누가`가 "보드 수정"이나 "사용자 판단"이면 고치지 말고 보고한다. 파일을 직접 써서 우회하지 않는다
6. 생성되는 프론트매터 형식(참고용):

   ```yaml
   ---
   title: {계획서 제목}
   lifecycle: record
   task_id: {task_id}            # 이슈가 없으면 생략
   repos: [{대상 저장소}]
   base: {브랜치}@{커밋}
   updated: {YYYY-MM-DD}
   ---
   ```

# 작업 계획 작성 규칙

- 계획 수립에 불확실한 내용이 있는 경우 작업을 중단하고 반드시 명확하게 확인 후 재개 할 것. 자율 모드에서는 중단하지 않고 최적안을 골라 `decisions.md`에 `D-n`으로 기록한 뒤 계속한다

## 문서에 반드시 표현되어야 할 내용

- Task에 대한 목표 및 개요
- 관련 문서 참조(앵커 사용)
- Sub-Task 목록 및 구현 순서
- 각 Sub-Task별 개요
- 개선 목표 또는 작업 목표
- 영향받는 파일
- 구현 작업
- 테스트 계획
- 구현 체크리스트
- 브랜치와 병합 — 작업 저장소의 진행 중 브랜치를 확인한다(`git -C <저장소> branch -a`, 최근 커밋). 기준 브랜치(예: `master`에서 hotfix, 또는 진행 중인 기능 브랜치), 진행 중 브랜치와의 병합 순서, 예상 충돌 파일을 쓴다. 기준 브랜치는 릴리스 결정이라 `decisions.md`에 기록한다
- 검증 결과를 남길 곳 — 재현 확인·QA 검증처럼 코드 밖에서 확인한 결과는 이슈 기록(이슈 폴더의 검증 기록, 산출물 구분 `검증`)으로 남긴다. MR 설명·커밋 메시지에만 두지 않는다

## 포함하지 말아야 할 내용

- 예상 소요 시간
- 구현 코드 및 테스트 코드
  - 단, 비즈니스 흐름을 표현하는 간단한 의사코드는 허용
- ASCII 다이어그램

# 권장 문서 길이

- **최소**: 150줄
- **최적**: 200-300줄
- **최대**: 400줄
