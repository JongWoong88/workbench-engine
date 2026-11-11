# workbench 형식 규칙

workbench 문서 저장소(이슈·기록·대응표)의 형식과 규칙의 정본이다. `wb` 명령과 lint가 이 문서대로 동작한다. 스킬이 따르는 이용 규칙(권한, 커밋 절차)은 [workbench-rules.md](workbench-rules.md)에 있다.

## 구성

엔진과 문서 저장소는 따로 있다.

| 구성 | 위치 | 내용 |
|---|---|---|
| 엔진 | 설치된 workbench 플러그인 | 스킬·`wb` 명령·lint·보드 설정(`board.yml`)·이 문서. 플러그인 갱신으로 바뀐다 |
| 문서 저장소 | 팀이 가진 git 저장소의 clone | `board/tasks/` 이슈, `records/` 기록, `projects.tsv` 대응표, `workbench.config.json` 공유 설정 |
| PC별 설정 | `~/.workbench/config.json` | 문서 저장소 위치, 서비스 저장소 폴더, git 원격 이름. 저장소에 넣지 않는다 |

`wb --help`의 `문서:` 줄이 이 PC의 문서 저장소 위치다. 아래 경로는 모두 문서 저장소 기준이다.

## <a id="핵심-규칙"></a>핵심 규칙

| 항목 | 규칙 | 예 |
|---|---|---|
| task_id | `{키}-{번호}`. 키는 `projects.tsv`, 번호는 `wb next-task-id`로 발급 | `APP-123` |
| 브랜치명 | `{유형}/{task_id}` — task_id와 브랜치가 1:1 | `feature/APP-123` |
| 이슈 파일 | `board/tasks/{task_id}.md` — 파일 이름이 task_id다 | `board/tasks/APP-123.md` |
| 기록 위치 | 이슈 있음 `records/{project}/{task_id}/`, 없음 `records/{project}/` | `records/app/APP-123/plan-refund.md` |
| 보드 수정 | `wb` 명령으로만 한다 | `wb move-task APP-123 design` |

## task_id

### 발급

```bash
wb next-task-id <project>     # 예: wb next-task-id app  →  APP-124
```

보드에 이슈를 만들 때는 발급과 기록을 한 번에 하는 `wb new-task`를 쓴다.

명령이 하는 일:

1. `projects.tsv`에서 project의 키를 찾는다
2. **같은 키를 쓰는 모든 project의 저장소**와 **문서 저장소**를 fetch한다
3. 다음에서 `{키}-{번호}`를 모아 최대값을 구한다
   - `projects.tsv`의 모든 저장소: 로컬·원격 브랜치명, 전체 커밋 메시지
   - 문서 저장소: 브랜치명, 커밋 메시지, 로컬 `board/tasks/`와 원격 브랜치마다의 `board/tasks/`
   - `records/{project}/{task_id}/` 폴더명
4. `{키}-{최대값+1}`을 출력한다

규칙:

- **번호는 반드시 명령으로 발급한다.** 손으로 세지 않는다
- 발급 즉시 이슈 파일을 만들어 번호를 예약하고 push한다. 기록 전에 다시 발급하면 같은 번호가 나온다
- stderr에 `fetch 실패` 경고가 나오면 사용자에게 알린다. 마지막으로 받아둔 원격 정보로 계산했으므로 번호가 겹칠 수 있다
- 한 번 부여한 task_id는 바꾸지 않는다. 폐기된 task의 번호도 재사용하지 않는다
- 저장소가 없는 project는 보드와 `records/`만 보고 번호를 센다

### project와 키 추가

`projects.tsv`에 없는 저장소의 작업이 생기면 **임의로 키를 만들지 말고 사용자에게 확인**한 뒤 한 줄을 추가한다.

| 열 | 값 |
|---|---|
| project | 저장소 이름에서 정한 짧은 값. 여러 저장소를 한 project로 묶을 때는 사용자와 정한다 |
| key | 그 저장소의 기존 브랜치에 쓰인 키가 있으면 그대로 쓴다(`git branch -r`로 확인) |
| repos | 저장소의 **논리 경로**. 워크스페이스 루트 기준 `{워크스페이스}/{저장소}` 형태(예: `group/app`). 쉼표로 여럿. 저장소가 없으면 `-` |
| remote | `repos`와 같은 순서·개수로 각 저장소의 호스트 저장소 경로(`git remote get-url origin`에서 호스트와 `.git`을 뗀 값). 없거나 쓰지 않으면 그 자리에 `-`. 저장소가 없는 project는 `-` 하나. 옛 이름은 `gitlab`이고 같은 열이다 |

열은 위치로 읽는다. 첫 줄의 주석(`# project key repos remote`)은 설명일 뿐이다.

## 보드 (`board/`)

### board.yml

컬럼과 뷰는 엔진이 정한다(플러그인의 `board.yml`). 문서 저장소에 `board/board.yml`이 있어도 읽지 않는다.

| 키 | 값 |
|---|---|
| `columns` | 컬럼 목록. 순서가 보드의 왼쪽→오른쪽 순서다. 항목은 `id`(영문 소문자·숫자·하이픈, 바꾸지 않는다), `label`(화면 이름), `state`(`waiting` 대기 / `active` 진행 / `closed` 종료), `color` |
| `views` | 뷰 목록. 항목은 `id`, `label`, 보일 컬럼 id 목록 `columns` |
| `description` | 워크플로 설명(마크다운). 모든 컬럼 이름이 들어 있어야 한다(lint 경고) |

### 이슈 파일

`board/tasks/{task_id}.md`. 프론트매터에 구조 정보를, 본문에 자유 마크다운 설명을 둔다. 필드 순서와 따옴표는 `wb` 명령이 고정해서 쓴다.

| 필드 | 필수 | 값 |
|---|---|---|
| `task_id` | ✔ | [발급](#발급) 규칙. 파일 이름과 같아야 한다 |
| `title` | ✔ | 이슈 제목 |
| `project` | ✔ | `projects.tsv`의 project 값 1개. 여러 project에 걸치면 대표 하나 |
| `type` | ✔ | **작업 유형** — `hotfix`, `feature`, `refact`, `improvement`, `research` 중 하나. 브랜치의 `{유형}`과 맞춘다 |
| `column` | ✔ | `board.yml` 컬럼 `id` |
| `author` | ✔ | 작성자. `wb new-task`를 실행한 문서 저장소의 `git config user.name`이고, `created` 이력의 `author`도 같은 값이다. 생략되어 있으면 `history` 첫 항목의 `author`를 쓴다 |
| `assigned` | | 담당자. 기본값은 작성자 |
| `created`·`started`·`completed` | `created`만 ✔ | ISO 8601 시각. **반드시 작은따옴표로 감싼다** — YAML 1.1 파서가 날짜 객체로 읽지 않게 하기 위해서다 |
| `archived` | | 보관된 이슈만 `true`. `wb archive-task`로만 바꾼다 |
| `parent` | | 상위 이슈의 task_id. 한 단계만 허용한다 |
| `outputs` | | 산출물 목록. 항목은 `kind`(구분), `path`(문서 저장소 기준: `records/…` 또는 `../{워크스페이스}/{저장소}/…`), `desc`. `wb link-output`으로만 추가한다 |
| `history` | | 생성·이동 이력. `wb` 명령이 덧붙인다 |

- 본문 링크는 이슈 파일 기준 상대경로로 쓴다. 예: `../../records/app/APP-123/plan-refund.md`
- 보관은 파일을 옮기지 않고 `archived: true`로 표시한다

### 상태 규칙

| # | 조건 | 결과 |
|---|---|---|
| S-1 | `active` 컬럼으로 옮기고 `started`가 비어 있음 | `started`를 이동 시각으로 채운다 |
| S-2a | `closed`가 아닌 컬럼에서 `closed` 컬럼으로 옮김 | `completed`를 이동 시각으로 채운다. `closed` 안의 이동은 날짜를 바꾸지 않는다 |
| S-2b | `closed`에서 다른 컬럼으로 옮김 | `completed`를 지운다 |
| S-3 | `closed` 컬럼으로 옮기는데 끝나지 않은 child가 있음 | 거부한다. 사용자가 정하면 `--force`로 옮긴다 |
| S-4 | 생성 | 생성 컬럼의 상태에 따라 S-1·S-2a를 적용한다 |
| S-5 | 보관 | `closed` 컬럼의 이슈만 보관한다. 보관된 이슈는 옮길 수 없고, 다시 진행하려면 먼저 꺼낸다(`--restore`) |

- 이슈가 `closed` 컬럼으로 가면 그 records 폴더는 동결된다
- 웹 편집기에서 `column`만 고친 이동도 허용한다. 이 경우 `started`·`completed`·`history`가 채워지지 않는다. pre-commit이 `TASK-MOVE-UNRECORDED`로 경고한다

## 기록 (`records/`)

```
records/
└── {project}/                 projects.tsv 의 project 값
    ├── {task_id}/             이슈 단위 기록 — 이슈의 task_id 와 같은 이름
    │   ├── discovery.md        현황 조사, 요구사항 검토
    │   ├── proposal.md         제안서
    │   ├── design-*.md         설계 초안, 결정 기록
    │   ├── plan-*.md           작업 계획
    │   └── decisions.md        agent 결정과 담당자 평가 (decisions-format.md)
    └── *.md                   이슈 없이 생긴 기록
```

- 기록 파일은 `wb new-record --to <task_id | project> --name <파일명> --title <제목>`으로 만든다. 위치·프론트매터(`base` 포함)를 채우고, 동결된 이슈면 거부한다
- 이슈가 있는 기록은 반드시 `{task_id}/` 폴더에 둔다. project는 **이슈의 `project` 값**을 따른다
- 이슈 없이 생긴 기록은 `records/{project}/`에 바로 두고, 사용자에게 알린다
- 이슈가 종료되면 그 폴더는 동결한다. 확정된 내용은 저장소의 상시 문서로 옮긴다(후보 목록: `wb absorb-candidates`)
- 비밀 정보는 두지 않는다

기록 문서 frontmatter:

```yaml
---
title: 환불 멱등성 작업 계획
lifecycle: record
task_id: APP-123        # 이슈가 없으면 생략
repos: [app]
base: main@a1b2c3d      # 작성 시점의 브랜치@커밋
updated: 2026-09-28
---
```

## 링크 규칙

모든 상대 링크는 **그 파일 기준**으로 해석한다(이슈 파일과 기록 모두).

| 대상 | 이슈 파일(`board/tasks/`)에서 | 이슈 폴더 기록(`records/{project}/{task_id}/`)에서 |
|---|---|---|
| 기록 문서 | `../../records/{project}/{task_id}/...` | 같은 폴더면 `design-x.md` |
| 다른 이슈 | `APP-123.md` | `../../../board/tasks/APP-123.md` |
| 서비스 저장소 | `../../../{논리 경로}/...` | `../../../../{논리 경로}/...` |

- 링크는 문서 저장소의 상위 폴더를 워크스페이스 루트로 보고 쓴다(`../../../`는 이슈 파일 기준, `../../../../`는 이슈 폴더 기록 기준). 이슈 없는 기록(`records/{project}/`)에서는 `../../../`
- 서비스 저장소가 이 PC의 다른 폴더에 있으면 링크는 그대로 두고 `wb config set workspace-root` 또는 `wb config set repo-path`로 실제 폴더를 알려 준다. lint는 논리 경로를 실제 폴더로 바꿔 확인한다
- `file:///D:/...` 같은 절대경로는 쓰지 않는다(PC마다 경로가 다르다)
- 문서 안의 특정 위치는 앵커로 가리킨다. ID가 있는 항목(표의 `O-12`, 제목의 `D-5` 등)은 그 항목에 `<a id="O-12"></a>`를 두고 `#O-12`로 링크한다 — 제목 slug는 제목 문구가 바뀌면 깨진다. 표 행은 ID 칸 맨 앞에, 제목은 제목 줄 안 맨 앞에 둔다. ID가 없는 절은 제목 slug(github-slugger 규칙)로 링크한다. 앵커 id는 문서 안에서 유일해야 하고 `wb-`로 시작하면 안 된다
- 산출물은 본문이 아니라 이슈의 `outputs`에 단다: `wb link-output --task <task_id> --kind <구분> --path <문서> --desc <설명>`. 구분은 워크플로 단계에 맞춘다(조사·제안·정책·결정·설계·작업계획·검토·검증·QA 등)

## 설정

예시 파일은 플러그인의 `templates/samples/`에 있다: `workbench.config.json`(공유 설정), `projects.tsv`(대응표), `user-config.json`(PC별 설정).

### 공유 설정 `workbench.config.json` (문서 저장소)

팀이 함께 쓰는 값이다. 커밋한다. 비밀을 넣지 않는다. 키는 모두 생략할 수 있고, 파일이 없어도 된다.

| 키 | 값 | 기본값 |
|---|---|---|
| `formatVersion` | 이 문서 저장소가 따르는 형식 버전 | 1 |
| `host.type` | `gitlab` · `github`. 코드·파일 링크 형식을 정한다 | 없음(링크를 만들지 않는다) |
| `host.web` | 호스트 웹 주소. `gitlab`이면 필요하다 | `github`이면 `https://github.com` |
| `host.api` | 호스트 API 주소 | 호스트 종류에 따라 정한다 |
| `repo` | 호스트의 문서 저장소 경로(예: `group/docs`) | 없음 |
| `branch` | 문서 저장소 기본 브랜치. 이슈·기록은 이 브랜치에만 커밋한다 | `main` |
| `docRoots` | 서비스 저장소 안 상시 문서 루트 후보 | `src/main/resources/docs`, `docs` |
| `board.fetchIntervalSec` | 보드 화면의 fetch 주기(초, 5 이상) | 30 |

`formatVersion`이 설치된 엔진이 아는 버전보다 높으면 `wb`는 플러그인 갱신을 안내하고 멈춘다(종료 코드 3).

### PC별 설정 `~/.workbench/config.json`

`wb config`로 읽고 쓴다. 손으로 고쳐도 된다 — JSON 키는 `dataRoot`, `workspaceRoot`, `repoPaths`(논리 경로 → 폴더), `remote`, `boardAutostart`다.

| 명령 | 뜻 |
|---|---|
| `wb config set data-root <경로>` | 문서 저장소 clone 위치. 환경변수 `WORKBENCH_ROOT`가 우선한다 |
| `wb config set workspace-root <경로>` | 서비스 저장소들의 공통 상위 폴더. 기본값은 문서 저장소의 상위 폴더. 환경변수 `WORKSPACE_ROOT`가 우선한다 |
| `wb config set repo-path <논리 경로> <폴더>` | 저장소 하나를 다른 폴더에 둔 경우 |
| `wb config set remote <이름>` | 문서 저장소 clone의 git 원격 이름(기본 `origin`) |
| `wb config set board-autostart on\|off` | Claude Code 세션이 시작되면 보드를 백그라운드로 띄우고(새로 띄울 때만 브라우저를 연다), 이 PC의 세션이 모두 끝나면 끈다. 비대화형 실행에는 띄우지 않는다. 기본 `off`. 세션 기록은 `~/.workbench/board-sessions/` |
| `wb config get` | 지금 값과 출처 |

## 도구 (`wb`)

이슈·기록의 형식이 정해진 일은 명령이 하고, 의미를 판단하는 일(내용 작성, 구분·설명 문구, 흡수 판단)만 에이전트·스킬이 한다. **보드·기록 파일의 형식을 손으로 만들지 말고 아래 명령을 쓴다.** 어느 폴더에서든 실행한다. 명령이 받는 경로는 문서 저장소 기준 상대경로로 써도 된다.

| 명령 | 할 일 |
|---|---|
| `wb next-task-id <project>` | 같은 키의 저장소와 문서 저장소를 fetch한 뒤 최대 번호 + 1을 출력 |
| `wb new-task --project --tag --title [--column] [--parent]` | task_id 발급 + `board/tasks/{task_id}.md` 생성(예약) |
| `wb move-task <task_id> <컬럼 id> [--force]` | 컬럼 이동, `started`·`completed`·`history` 기록. 끝나지 않은 child가 있으면 종료 거부, 보관된 이슈는 거부 |
| `wb archive-task <task_id> [--restore]` | 종료 이슈 보관·꺼내기 |
| `wb find-task <task_id \| 제목>` | 이슈 파일·project·작성자·컬럼·종료 여부·records 폴더·산출물을 JSON으로. 후보가 여럿이면 `ambiguous` |
| `wb new-record --to <task_id \| project> --name --title [--repos]` | 위치 결정, 프론트매터(`repos`·`base`) 생성. 동결된 이슈면 거부 |
| `wb link-output --task --kind --path --desc` | 이슈 `outputs`에 한 항목 추가. 경로 확인, 중복 방지 |
| `wb lint [--changed \| --staged \| --files … \| --all]` | 규칙 검사([lint 검사 항목](#lint-검사-항목)). 오류가 있으면 종료 코드 1 |
| `wb sync begin [--files …]` / `wb sync commit --files … --message …` | 이슈·기록 변경을 기본 브랜치에 커밋·push. 같은 PC의 여러 에이전트가 동시에 불러도 잠금으로 하나씩 돈다 |
| `wb absorb-candidates [--task \| --project] [--since]` | 종료 이슈의 기록과 대상 저장소의 문서 루트 목록 |
| `wb decision-stats [--task \| --project] [--by harness] [--check]` | 이슈 폴더 `decisions.md`의 담당자 평가 지표와 형식 검사 |
| `wb config …` | PC별 설정 |
| `wb board [--port] [--open] [--worktree] [--no-fetch] [--background]`, `wb board --stop` | 로컬 보드. 문서 저장소 clone의 원격 기본 브랜치를 읽어 `127.0.0.1`에 띄운다. 터미널에서는 그 자리에서 돌고(Ctrl+C로 끝), 터미널이 아니면(에이전트) 백그라운드로 띄우고 바로 돌아온다. 이미 떠 있으면 그 주소를 알린다. `--stop`이 끈다. 떠 있는 보드는 `~/.workbench/board.json`에 적는다. `--auto`는 세션 시작 훅(`board-autostart`)이 쓴다 |
| `wb init <폴더> --host gitlab\|github [--web] [--repo] [--branch] [--set-data-root]` | 새 문서 저장소 템플릿(보드·기록 폴더, 대응표 머리, 공유 설정, hook, CI 파일) |
| `wb --version` | 설치 버전. 결정 기록의 하네스 값으로 쓴다 |

문서 저장소의 pre-commit hook(`.githooks/pre-commit`, `git config core.hooksPath .githooks`)은 `wb lint --staged`를 돌려 오류가 있으면 커밋을 거부한다. 그 터미널에 `wb`가 없으면 경고만 하고 통과시킨다. push 뒤 CI lint가 검사한다.

### 응답 규약

모든 명령은 같은 형식으로 답한다. `--json`을 붙이면 같은 내용을 JSON(`ok`, `code`, `message`, `file`, `line`, `fix[]`, `owner`, `rerun`)으로 준다.

| 종료 코드 | 뜻 | 할 일 |
|---|---|---|
| 0 | 성공 | 출력의 `다음:`·`참고:` 줄을 따른다 |
| 1 | 거부 — 내용이 규칙에 맞지 않음 | `수정`대로 고치고 `확인` 명령으로 다시 실행한다 |
| 2 | 사용법 오류 | 인자를 고쳐 다시 실행한다 |
| 3 | 환경 오류 | `수정`대로 환경을 갖춘다 (예: `wb config set data-root`, 플러그인 갱신) |
| 70 | 내부 오류 | 명령 결함이다. 우회하지 말고 사용자에게 보고한다 |

거부 메시지의 `누가` 줄이 고칠 주체를 정한다:

- **에이전트가 바로 고친다** — 기록 프론트매터, 링크 경로, 산출물 누락 등
- **보드 수정이다** — 이슈 속성. 사용자가 지시한 작업 범위 안이면 고치고, 아니면 고치지 말고 보고한다
- **사용자 판단이 필요하다** — task_id 중복, 동결된 기록, 폴더·project 불일치, 설정 파일 등. 고치지 말고 보고해 결정을 받는다

거부를 피하려고 파일을 직접 써서 우회하지 않는다. `--force`, `--no-verify`는 사용자가 명시적으로 결정했을 때만 쓴다.

### lint 검사 항목

| 묶음 | 규칙 | 심각도 |
|---|---|---|
| 보드 | `BOARD-CONFIG`(엔진 board.yml 형식 — 오류, description에 없는 컬럼 — 경고), `TASK-FORMAT`, `TASK-FIELD`(필수 필드 누락), `TASK-FILE`(파일 이름 ≠ task_id), `TASK-ID-FORMAT`, `TASK-PROJECT`, `TASK-KEY`, `TASK-TYPE`, `TASK-COLUMN`, `TASK-PARENT`, `TASK-OUTPUT`, `TASK-ARCHIVED`, `TASK-ID-DUP` | 오류 |
| 보드 | `TASK-DATE` — 따옴표 없는 시각(오류), `closed`인데 `completed` 없음(경고) | 오류·경고 |
| 대응표 | `TSV-REMOTE`(옛 이름 `TSV-GITLAB`: remote 열 없음, 항목 수가 repos와 다름) | 오류 |
| 설정 | `CONFIG-SHARED`(공유 설정의 잘못된 값 — 오류, 모르는 키 — 경고) | 오류·경고 |
| 기록 | `REC-PROJECT`, `REC-ISSUE`, `REC-ISSUE-PROJECT`, `REC-FM-MISSING`·`REC-FM-FIELD`, `REC-LIFECYCLE`, `REC-TASKID`, `REC-UNLINKED` | 오류 |
| 동결 | `REC-FROZEN` — 종료된 이슈의 기록을 바꿈 | 경고 |
| 링크 | `LINK-ABS`, `LINK-BROKEN`, `LINK-ANCHOR` | 오류 |
| 링크 | `LINK-EXTERNAL`(서비스 저장소 링크가 `base` 커밋에도 지금 체크아웃에도 없음, 저장소가 없는 PC에서는 건너뜀), `LINK-REMOVED`(문서 저장소 안 대상이 지금은 없지만 그 파일의 이력에는 있었음), `LINK-PROSE`, `LINK-ANCHOR-ID` | 경고 |
| 보드 | `TASK-MOVE-UNRECORDED` — 스테이징된 이슈의 `column`이 HEAD와 다른데 그 이동이 `history`에 없음. `--staged`에서만 | 경고 |
| 기타 | `EOL-CRLF`, `EOL-CONFIG` | 경고 |

**경고는 커밋·명령을 막지 않는다.** 엔진이 새 오류 규칙을 더해도 문서 저장소의 `formatVersion`이 그 규칙의 도입 버전보다 낮으면 경고로 나온다. 고친 뒤 `formatVersion`을 올리면 오류로 검사한다.

`--changed`·`--staged`·`--files`는 대상 파일과 겹치는 위반만 보이고, 대상 밖의 기존 위반은 건수만 알린다.
