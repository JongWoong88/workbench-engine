---
name: setup
description: 이 PC에서 workbench를 쓸 수 있게 구성한다 — 팀의 기존 문서 저장소에 합류(clone, 문서 저장소 위치 설정, 커밋 전 검사 연결)하거나, 문서 저장소를 새로 만든다(wb init, projects.tsv, 원격 연결, 첫 push). 서비스 저장소 위치 확인, 터미널용 wb 설치(선택), 보드 확인까지 한다. "workbench 설정해 줘", "workbench 처음 쓰는데 구성해 줘", "문서 저장소 연결해 줘", "문서 저장소 새로 만들어 줘", "wb init 해 줘" 같은 요청이나, wb가 ENV-DATA-ROOT로 거부하거나 세션 안내에 문서 저장소 위치가 정해지지 않았다고 나왔을 때 쓴다. 이슈·기록 작업은 다른 workbench 스킬이 한다.
argument-hint: "[합류 | 새로 만들기] [문서 저장소 clone 주소 또는 경로]"
allowed-tools: Bash(wb *), Read, Grep, Glob
---

# workbench 구성

이 PC에서 workbench를 쓸 수 있게 한다. 사용법·설정의 사람용 안내는 [README.md](${CLAUDE_PLUGIN_ROOT}/README.md), 설정 키의 정본은 [workbench-format.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-format.md)의 "설정"이다.

## 0. 규칙

- **사용자가 정할 값은 추측하지 않는다.** 아래 표의 "반드시 묻는다" 값은 사용자의 답 없이 정하지 않는다. 후보를 찾아 제안할 수는 있지만 정하는 것은 사용자다. 기본값이 있는 값도 기본값을 보여 주고 확인받는다.
- 묻는 일은 한 번에 모아서 한다. 질문 도구(예: AskUserQuestion)가 있으면 쓰고, 없으면 번호 붙인 목록으로 묻는다. 답을 받은 뒤 **실행 전에 정한 값을 표로 보여 주고 확인받는다.**
- 원격에 영향을 주는 일(호스트에 저장소 만들기, 첫 push)과 전역 설치(`npm i -g`)는 사용자가 확인한 뒤에만 한다.
- 비밀(토큰·비밀번호)을 묻거나 다루지 않는다. git 인증이 필요하면 사용자가 터미널에서 직접 하게 안내한다(예: `! git fetch`로 한 번 로그인).
- `wb` 명령이 거부하면 출력의 `수정`·`누가`대로 한다. 거부를 피하려고 파일을 직접 쓰지 않는다. 단 projects.tsv의 project 줄은 이 스킬이 쓴다(아래 4단계).

## 1. 지금 상태

1. `wb --help` — `문서:` 줄(문서 저장소 위치)과 `엔진:` 줄(설치 위치·버전)을 본다
2. `wb config get` — 서비스 저장소 폴더(workspace-root)와 projects.tsv 저장소 중 이 PC에 없는 것을 본다

문서 저장소가 이미 정해져 있으면 사용자에게 무엇을 바꾸려는지 묻는다(다른 문서 저장소로 바꾸기, 서비스 저장소 위치만 고치기, 확인만). 확인만이면 7단계로 간다.

## 2. 갈래 정하기

사용자에게 묻는다: **팀의 문서 저장소가 이미 있는가?**

| 답 | 갈래 |
|---|---|
| 있다(호스트에 있거나 이 PC에 clone이 있다) | 3단계 합류 |
| 없다, 새로 만든다 | 4단계 새로 만들기 |
| 모른다 | 팀에 확인하라고 안내하고 멈춘다. 같은 팀이 문서 저장소를 둘 만들면 보드가 갈라진다 |

## 3. 합류

반드시 묻는다:

| 값 | 묻는 말 | 제안할 수 있는 것 |
|---|---|---|
| clone 주소 또는 이미 있는 clone 경로 | "문서 저장소의 clone 주소(또는 이 PC의 clone 경로)는?" | 없음 |
| clone 위치 (새로 clone할 때) | "어디에 clone할까요?" | 서비스 저장소들의 공통 상위 폴더(워크스페이스 루트) 바로 아래. 그러면 workspace-root를 따로 정하지 않아도 된다 |

확인받은 뒤:

1. 새로 clone하면 `git clone <주소> <위치>`. 인증 오류면 사용자가 터미널에서 로그인하게 안내하고 기다린다
2. `wb config set data-root <clone 경로>` — `board/`가 없으면 거부된다. 그때는 주소가 맞는지 사용자에게 확인한다
3. `git -C <clone 경로> config core.hooksPath .githooks` — 커밋 전 검사를 켠다(`.githooks/pre-commit`이 있을 때)
4. clone이 기본 브랜치(공유 설정 `branch`, 기본 `main`)에 있는지 `git -C <clone 경로> branch --show-current`로 본다. 다른 브랜치면 사용자에게 알린다
5. 5단계로 간다

## 4. 새로 만들기

### 4-1. 반드시 묻는 값

아래 값은 **빠짐없이** 묻는다. `wb init`을 이 값 없이 실행하지 않는다.

| 값 | `wb init` 인자 | 묻는 말 | 제안할 수 있는 것 |
|---|---|---|---|
| 폴더 | `<폴더>` | "문서 저장소를 어디에 만들까요?" | 워크스페이스 루트 바로 아래의 새 폴더 |
| 호스트 종류 | `--host gitlab\|github` | "문서 저장소와 서비스 저장소는 GitLab과 GitHub 중 어디에 있나요?" | 서비스 저장소의 `git remote get-url origin` |
| 호스트 웹 주소 | `--web` | "호스트 웹 주소는?" (GitLab이면 필수. GitHub는 github.com이면 생략, GitHub Enterprise면 그 주소) | 위 remote 주소의 호스트 부분 |
| 호스트의 문서 저장소 경로 | `--repo` | "호스트에서 이 저장소의 경로는? (예: group/docs)" | 없음. 보드의 파일 링크에 쓴다. 정하지 않으면 링크가 생기지 않는다고 알린다 |
| 기본 브랜치 | `--branch` | "기본 브랜치는 main으로 할까요?" | `main` |
| 이 PC의 문서 저장소로 쓰기 | `--set-data-root` | "이 PC에서 이 저장소를 쓸까요?" | 예 |
| project 목록 | (projects.tsv) | "처음 등록할 project를 알려 주세요: project 이름, task_id 키, 서비스 저장소" | 아래 4-2 |
| 원격 저장소 | (git remote) | "호스트에 빈 저장소를 만들었나요? 주소는?" | 호스트 CLI(`gh`, `glab`)가 있고 사용자가 원하면 에이전트가 만들 수 있다. 공개 범위는 비공개를 권한다 |

### 4-2. project 줄 정하기

projects.tsv는 한 줄에 project 하나, 열 네 개(탭 구분)다. 형식은 [workbench-format.md](${CLAUDE_PLUGIN_ROOT}/references/workbench-format.md)의 "project와 키 추가", 예시는 [templates/samples/projects.tsv](${CLAUDE_PLUGIN_ROOT}/templates/samples/projects.tsv)다.

| 열 | 정하는 법 |
|---|---|
| project | 저장소 이름에서 짧게. 사용자에게 확인한다 |
| key | task_id 접두사(대문자로 시작, 대문자·숫자). 그 저장소의 브랜치에 이미 쓰인 키가 있으면 그것을 후보로 보여 준다(`git -C <저장소> branch -a`에서 `{유형}/{키}-{번호}` 모양). **키는 사용자가 정한다** |
| repos | 저장소의 논리 경로 = 워크스페이스 루트 기준 상대 경로(예: `group/app`). 여럿이면 쉼표. 저장소가 없는 project는 `-` |
| remote | repos와 같은 순서·개수로 호스트 저장소 경로(`git remote get-url origin`에서 호스트와 `.git`을 뗀 값). 없으면 그 자리에 `-` |

### 4-3. 실행

정한 값을 표로 보여 주고 확인받은 뒤:

1. `wb init <폴더> --host <종류> [--web <주소>] [--repo <경로>] [--branch <브랜치>] [--set-data-root] --json`
2. projects.tsv에 확인받은 줄을 더한다. 열은 탭, 줄 끝은 LF. `init`이 쓴 주석 줄은 두어도 된다
3. `wb lint --all` — 오류가 있으면 고친다
4. 원격 연결과 첫 커밋·push — 사용자가 확인한 뒤:
   - `git -C <폴더> remote add origin <주소>`
   - `git -C <폴더> add -A` → `git -C <폴더> commit -m "chore: workbench 문서 저장소 초기화"` (에이전트가 커밋에 붙이는 공동 작성자 줄이 있으면 넣는다) → `git -C <폴더> push -u origin <브랜치>`
   - 처음 커밋은 원격이 없어 `wb sync`를 쓸 수 없으므로 git을 직접 쓴다. **이후 모든 커밋은 `wb sync`로만 한다**
5. 사용자에게 알린다(사람이 할 일):
   - 호스트에서 기본 브랜치에 직접 push할 수 있게 둔다(스킬이 기본 브랜치에 push한다). 보호 규칙이 막으면 스킬 커밋이 거부된다
   - CI가 돌게 한다: GitLab은 러너가 `node:22` 이미지를 받을 수 있어야 한다. GitHub는 Actions가 켜져 있어야 한다. 외부 npm에 닿지 않는 환경은 CI 변수 `NPM_CONFIG_REGISTRY`에 미러 주소를 둔다
   - 팀원에게 clone 주소를 알린다. 팀원은 플러그인을 설치하고 이 스킬의 "합류"로 구성한다

## 5. 서비스 저장소 위치

`wb config get`의 "이 PC에 없다" 목록을 본다.

- 없는 저장소가 없으면 넘어간다
- 서비스 저장소들이 문서 저장소의 상위 폴더가 아닌 곳에 모여 있으면, 그 폴더를 사용자에게 확인하고 `wb config set workspace-root <폴더>`
- 저장소 하나만 다른 곳에 있으면 `wb config set repo-path <논리 경로> <폴더>`
- 아직 clone하지 않은 저장소는 그대로 둔다. 쓸 때 clone하면 된다고 알린다
- 다시 `wb config get`으로 확인한다

## 6. 터미널에서 쓰는 `wb` (선택)

`wb`는 에이전트용 명령이다. Claude Code 세션 안에서만 PATH에 있고, 사람이 연 터미널에는 없다. 사용자에게 묻는다: "터미널에서도 `wb`를 직접 쓰시겠어요?"

- 아니오면 넘어간다. 보드를 포함한 모든 일을 에이전트에게 시키면 된다
- 예면, 확인받은 뒤 `npm i -g @fiveeyes/workbench-engine`. 사내 미러를 쓰면 먼저 `npm config set @fiveeyes:registry <미러 주소>`(주소는 사용자에게 묻는다)
- 알린다: 전역 설치는 플러그인과 따로 갱신된다(`npm update -g @fiveeyes/workbench-engine`). 설치하면 터미널 커밋에서도 커밋 전 검사가 돈다

## 7. 확인과 보고

1. `wb --help` — `문서:` 줄이 정한 경로다
2. `wb lint --all` — 오류 0
3. 사용자에게 보드를 띄울지 묻고, 원하면 `wb board --open`(백그라운드로 뜨고 바로 돌아온다. 끌 때는 `wb board --stop`). 새로 만든 저장소를 아직 push하지 않았으면 `--worktree`를 붙인다
4. 보고: 정한 값(문서 저장소 경로, 호스트, project·키, workspace-root), 실행한 일, 사람이 할 일(4-3의 5, 플러그인 자동 갱신 켜기: `/plugin` → 마켓플레이스 화면)
