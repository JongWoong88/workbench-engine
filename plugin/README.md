# workbench 플러그인

작업 이슈(보드)와 기록 문서를 git 저장소 하나에 두고, Claude Code 에이전트와 사람이 같은 clone을 보며 일하게 하는 플러그인이다. 형식 규칙의 정본은 [references/workbench-format.md](references/workbench-format.md), 스킬이 따르는 이용 규칙은 [references/workbench-rules.md](references/workbench-rules.md)다.

## 구성

| 구성 | 내용 |
|---|---|
| 엔진(이 플러그인) | 스킬, `wb` 명령(이슈·기록·lint·커밋), 보드 설정, 형식 규칙. 플러그인 갱신으로 바뀐다 |
| 문서 저장소(팀 소유) | `board/tasks/` 이슈, `records/` 기록, `projects.tsv` 대응표, `workbench.config.json` 공유 설정 |
| PC별 설정 | `~/.workbench/config.json` — 문서 저장소 위치, 서비스 저장소 폴더 |

## 이 플러그인이 하는 일과 하지 않는 일

| 한다 | 하지 않는다 |
|---|---|
| 보드 이슈 생성·수정·보관 스킬, 기록 문서(조사·제안·설계·작업 계획·검토) 스킬, 산출물 링크와 커밋·push | 도구 실행을 막거나 바꾸는 훅, 출력 스타일, MCP 서버, 기본 에이전트 교체 — 다른 프로젝트에서의 에이전트 동작은 바꾸지 않는다 |
| 명령 진입점 `wb` (허용된 workbench 명령만 실행) | 사용자 설정 변경 |
| 세션 시작 안내 훅 하나([`hooks/session-context.mjs`](hooks/session-context.mjs)) — `wb`와 규칙 문서의 위치, 문서 저장소 위치, task_id 접두사를 세션 컨텍스트에 싣는다 | 규칙 본문을 싣는 것 — 안내와 경로만 싣는다 |

## 준비물

- Node 22 이상, git(문서 저장소에 push할 수 있는 자격 증명), Claude Code
- 문서 저장소 clone. 서비스 저장소들은 문서 저장소와 같은 상위 폴더(워크스페이스 루트) 아래 두는 것이 기본이다. 다른 곳에 두면 [PC별 설정](#pc별-설정)으로 알려 준다

## 설치

```bash
claude plugin marketplace add JongWoong88/workbench-engine
claude plugin install workbench@fiveeyes --scope user
```

에이전트는 서비스 저장소에서도 실행되므로 사용자 범위로 설치한다. 공식 외 마켓플레이스는 자동 갱신이 기본으로 꺼져 있다. `/plugin`의 마켓플레이스 화면에서 자동 갱신을 켜 두기를 권한다.

그다음 문서 저장소 위치를 알려 준다.

```bash
wb config set data-root <문서 저장소 clone 경로>
```

문서 저장소에서 커밋 전 검사를 쓰려면 한 번 `git config core.hooksPath .githooks`를 실행한다(`.githooks/pre-commit`이 문서 저장소에 있어야 한다). 터미널에 `wb`가 없으면 hook은 경고만 하고 통과시킨다.

## 확인

1. `claude plugin list` — `workbench@fiveeyes`가 켜져 있다
2. 새 Claude Code 세션에서 `/workbench:`를 입력하면 스킬 목록이 보인다
3. 에이전트에게 "wb --help 실행해 줘" — `문서:` 줄에 문서 저장소 경로가, `엔진:` 줄에 설치 위치와 버전이 나온다

## 새 문서 저장소 만들기

팀에 문서 저장소가 아직 없으면 한 사람이 만든다.

```bash
wb init <폴더> --host gitlab --web https://gitlab.example.com --repo group/docs --set-data-root
# GitHub면: wb init <폴더> --host github --repo owner/docs --set-data-root
```

보드·기록 폴더, `projects.tsv` 머리, `workbench.config.json`, `.githooks/pre-commit`, 호스트에 맞는 CI 파일을 만들고 `git init`과 `core.hooksPath`까지 한다. 그다음 `projects.tsv`에 project를 추가하고 커밋해 호스트의 빈 저장소로 push한다. 다른 사람은 그 저장소를 clone하고 `wb config set data-root`만 하면 된다.

- 호스트에는 기본 브랜치에 직접 push할 수 있게 둔다(`wb sync`가 기본 브랜치에 push한다)
- 문서 저장소는 비공개를 권한다. 이슈·기록을 읽을 수 있는 사람이 곧 보드를 볼 수 있는 사람이다

## 사내 npm 미러

외부 npm 레지스트리에 닿지 못하는 환경은 미러를 쓴다. 미러가 이 패키지(`@fiveeyes/workbench-engine`)를 프록시해야 한다.

| 곳 | 설정 |
|---|---|
| PC(플러그인 설치·갱신) | Claude Code는 사용자의 npm 설정으로 패키지를 받는다: `npm config set @fiveeyes:registry <미러 주소>` |
| 문서 저장소 CI | CI 변수 `NPM_CONFIG_REGISTRY=<미러 주소>`를 두거나, CI 파일의 `npx` 앞에 같은 환경변수를 둔다 |

## PC별 설정

| 상황 | 명령 |
|---|---|
| 문서 저장소 위치 | `wb config set data-root <경로>` |
| 서비스 저장소를 문서 저장소와 다른 상위 폴더에 둠 | `wb config set workspace-root <경로>` |
| 저장소 하나만 다른 폴더에 둠 | `wb config set repo-path <projects.tsv의 논리 경로> <폴더>` |
| 문서 저장소의 git 원격 이름이 origin이 아님 | `wb config set remote <이름>` |
| 지금 값 | `wb config get` |

## 쓰는 법

| 스킬 | 이렇게 말하면 된다 |
|---|---|
| `/workbench:new-task` | "이 작업 workbench 이슈로 만들어 줘. 유형은 feature" |
| `/workbench:update-task` | "APP-123 design으로 옮겨 줘", "완료 처리해", "제목 바꿔 줘" |
| `/workbench:archive-task` | "끝난 이슈 APP-120 보관해 줘" |
| `/workbench:groundwork` | "APP-123 현황 조사해서 정리해 줘", "제안서 써 줘", "설계 초안 써 줘" |
| `/workbench:plan` | "APP-123 작업 계획 세워 줘" |
| `/workbench:orchestrate` | "APP-123 계획까지 자동으로 진행해 줘" — Discovery부터 Planning까지 멈추지 않고 진행하고, 결정은 이슈 폴더 `decisions.md`에 남긴다 |
| `/workbench:evaluate-decisions` | "APP-123 결정 평가할게. D-2 수정, 나머지 승인" |
| `/workbench:proposal-review` | "이 제안서 3관점으로 검토해 줘" |
| `/workbench:documentation` | "이 저장소 정책 문서 갱신해 줘", "끝난 이슈 기록을 저장소 문서로 옮겨 줘" |

- 보드를 바꾸는 스킬은 사람이 지시했을 때만 동작한다
- 스킬은 끝날 때 바꾼 파일만 문서 저장소의 기본 브랜치에 커밋·push한다
- 이슈 본문의 기본 틀은 없다. 스킬이 말한 내용만 정리해 두면, 그다음은 직접 고친다

## 갱신과 제거

- 갱신: 자동 갱신을 켰으면 할 일이 없다. 수동이면 `claude plugin update workbench@fiveeyes`. 열린 세션은 `/reload-plugins`
- 하위호환 갱신은 문서 저장소를 고치지 않는다. 문서 저장소가 더 새 형식이면 `wb`가 갱신을 안내하고 멈춘다
- 제거: `claude plugin uninstall workbench@fiveeyes`. 문서 저장소와 `~/.workbench/`는 그대로 남는다

## 알아 둘 것

- **문서 저장소 clone은 기본 브랜치에 둔다.** 스킬은 기본 브랜치에서만 커밋하고, 다른 브랜치면 쓰기 전에 멈춘다
- **손으로 고친 파일이 있으면 스킬이 멈춘다.** 섞어 커밋하지 않기 위해서다. 그 편집을 먼저 커밋하거나 되돌린 뒤 다시 시킨다
- 커밋은 `fetch → commit → push` 순서로 한다. push가 거부되면 원격 변경 위에 다시 올려 한 번 더 시도한다. 되돌리지 못하면 push하지 않고 알린다
- 스킬은 필요한 명령을 미리 승인받아 승인 창 없이 돈다. 다만 검토 에이전트를 부르는 스킬(`groundwork`, `plan`, `proposal-review`)은 검토가 끝난 뒤의 수정·커밋에서 승인 창이 한 번 뜰 수 있다. 매번 승인하기 번거로우면 사용자 설정에 `Bash(wb *)` 허용 규칙을 직접 넣어도 된다 — 플러그인은 사용자 설정을 건드리지 않는다
- 플러그인이 막을 수 없는 이 PC의 설정: 권한 deny 규칙, 관리형 정책, 사용자 훅, 사용자 `CLAUDE.md`. 이것들이 스킬과 부딪히면 그 설정이 이긴다

## 문제 해결

| 메시지 | 뜻 | 할 일 |
|---|---|---|
| `ENV-DATA-ROOT` | 문서 저장소 위치가 정해지지 않았거나 문서 저장소가 아니다 | `wb config set data-root <경로>` |
| `ENV-FORMAT-NEWER` | 문서 저장소가 이 엔진보다 새 형식이다 | 플러그인을 갱신한다 |
| `SYNC-NOT-MAIN` | 문서 저장소 clone이 다른 브랜치에 있다 | 브랜치 작업을 마치고 기본 브랜치로 돌아간다 |
| `SYNC-DIRTY-TARGET`, `SYNC-STAGED-OTHER` | 손으로 고친 내용이 있다 | 그 편집을 커밋하거나 되돌린다 |
| `SYNC-CONFLICT`, `SYNC-DIVERGED` | 원격과 충돌했다 | 직접 정리한다. 번호가 겹쳤으면(같은 이슈 파일) 한쪽 번호를 새로 발급한다 |
| `SYNC-AUTH` | 원격 저장소에 접근하지 못했다 | 터미널에서 `git fetch`로 한 번 로그인한다 |
| `wb: command not found` | 플러그인이 꺼져 있거나 PowerShell 도구에서 찾지 못했다 | `claude plugin list` 확인. PowerShell이면 `wb.cmd` 전체 경로로 실행한다 |
