# workbench 플러그인 사용 안내

작업 이슈(칸반 보드)와 기록 문서를 팀의 git 저장소 하나에 두고, Claude Code 에이전트와 사람이 같은 clone을 보며 일하게 하는 플러그인이다. 왜 필요한지와 전체 워크플로는 [프로젝트 소개](https://github.com/JongWoong88/workbench-engine#왜-필요한가)에 있다. 이 문서는 설치하고 구성하고 쓰는 법이다.

형식 규칙의 정본은 [references/workbench-format.md](references/workbench-format.md), 스킬이 따르는 이용 규칙은 [references/workbench-rules.md](references/workbench-rules.md)다.

## 구성

| 구성 | 위치 | 내용 |
|---|---|---|
| 엔진(이 플러그인) | Claude Code가 설치한 폴더 | 스킬, `wb` 명령, 보드 화면과 설정, 형식 규칙. 플러그인 갱신으로 바뀐다 |
| 문서 저장소 | 팀이 가진 git 저장소의 clone | `board/tasks/` 이슈, `records/` 기록, `projects.tsv` 대응표, `workbench.config.json` 공유 설정 |
| PC별 설정 | `~/.workbench/config.json` | 문서 저장소 위치, 서비스 저장소 폴더, git 원격 이름 |
| 서비스 저장소 | 보통 문서 저장소와 같은 상위 폴더(워크스페이스 루트) 아래 | 실제 코드. 이슈의 브랜치 `{유형}/{task_id}`가 여기에 생긴다 |

**`wb`는 에이전트가 쓰는 명령이다.** 플러그인을 설치하면 Claude Code 세션 안의 셸에만 `wb`가 생기고, 사람이 따로 연 터미널에는 없다. 구성, 이슈·기록 작업, 보드 실행까지 모두 에이전트에게 말로 시키면 된다. 터미널에서 직접 쓰고 싶으면 [따로 설치](#터미널에서-wb-직접-쓰기)한다.

## 이 플러그인이 하는 일과 하지 않는 일

| 한다 | 하지 않는다 |
|---|---|
| 보드 이슈 생성·수정·보관 스킬, 기록 문서(조사·제안·설계·작업 계획·검토) 스킬, 산출물 링크와 커밋·push | 도구 실행을 막거나 바꾸는 훅, 출력 스타일, MCP 서버, 기본 에이전트 교체 — 다른 프로젝트에서의 에이전트 동작은 바꾸지 않는다 |
| 명령 진입점 `wb` (허용된 workbench 명령만 실행) | 사용자 설정 변경, 전역 패키지 설치(요청할 때만 에이전트가 한다) |
| 세션 시작 훅([`hooks/session-context.mjs`](hooks/session-context.mjs)) — `wb`와 규칙 문서의 위치, 문서 저장소 위치, task_id 접두사를 세션 컨텍스트에 싣는다. 문서 저장소가 정해지지 않았으면 구성하라고 알린다. [보드 자동 실행](#세션과-함께-자동으로-띄우기)을 켰으면 보드를 띄운다 | 규칙 본문을 싣는 것 — 안내와 경로만 싣는다 |
| 세션 종료 훅([`hooks/session-end.mjs`](hooks/session-end.mjs)) — 보드 자동 실행을 켰을 때만 끝난 세션의 기록을 지운다 | 그 밖의 세션 종료 처리 |

## 준비물

- Node 22 이상, git, Claude Code
- 문서 저장소에 push할 수 있는 git 자격 증명. 에이전트는 비밀번호·토큰을 다루지 않는다. 인증이 필요하면 터미널에서 `git fetch` 등으로 한 번 로그인해 둔다

## 설치

```bash
claude plugin marketplace add JongWoong88/workbench-engine
claude plugin install workbench@fiveeyes --scope user
```

- 에이전트는 서비스 저장소에서도 실행되므로 사용자 범위(`--scope user`)로 설치한다
- 플러그인은 npm 패키지 `@fiveeyes/workbench-engine`으로 배포된다. 설치하면 Claude Code가 그 패키지를 플러그인 폴더에 받는다. 패키지에는 실행에 필요한 것이 모두 들어 있어 따로 설치할 의존 패키지가 없다
- 공식 외 마켓플레이스는 자동 갱신이 기본으로 꺼져 있다. `/plugin`의 마켓플레이스 화면에서 자동 갱신을 켜 두기를 권한다
- 설치한 뒤에는 **새 세션**을 연다. 열려 있던 세션은 `/reload-plugins` 뒤에 스킬과 `wb`가 보인다

## 구성

### 에이전트에게 맡기기 (권장)

새 세션에서 **"workbench 설정해 줘"**라고 말한다. 에이전트가 `/workbench:setup` 스킬대로 진행한다. 값은 추측하지 않고 묻고, 실행 전에 정한 값을 보여 주고 확인받는다.

| 갈래 | 에이전트가 묻는 것 | 에이전트가 하는 일 |
|---|---|---|
| 팀 문서 저장소에 합류 | clone 주소(또는 이미 있는 clone 경로), clone할 위치 | clone, `data-root` 설정, 커밋 전 검사 연결, 기본 브랜치 확인 |
| 새 문서 저장소 만들기 | 폴더 위치, 호스트 종류(GitLab·GitHub), 호스트 웹 주소, 호스트의 저장소 경로, 기본 브랜치, 처음 등록할 project와 task_id 키·서비스 저장소, 호스트의 빈 저장소 주소 | `wb init`, `projects.tsv` 작성, 검사, 원격 연결, 첫 커밋·push |
| 공통 | 서비스 저장소가 다른 폴더에 있는지, 터미널용 `wb`를 설치할지, 세션을 열 때 보드를 자동으로 띄울지 | `workspace-root`·`repo-path` 설정, (원할 때) 전역 설치·보드 자동 실행, 확인과 보드 실행 |

사람이 해야 하는 일:

- 호스트에 빈 저장소 만들기(호스트 CLI가 있으면 에이전트에게 맡길 수 있다)와 git 로그인
- 호스트에서 기본 브랜치에 직접 push할 수 있게 두기. 스킬이 기본 브랜치에 push한다
- 문서 저장소 CI가 돌게 하기: GitLab은 러너가 `node:22` 이미지를 받을 수 있어야 하고, GitHub는 Actions가 켜져 있어야 한다
- 팀원에게 clone 주소 알리기. 팀원은 플러그인을 설치하고 "workbench 설정해 줘. 기존 문서 저장소에 합류할게"라고 하면 된다

### 직접 구성하기

아래 `wb` 명령은 에이전트에게 시키거나, [터미널용 `wb`](#터미널에서-wb-직접-쓰기)를 설치한 터미널에서 실행한다.

#### 팀 문서 저장소에 합류

```bash
git clone <문서 저장소 주소> <워크스페이스 루트>/<폴더>
wb config set data-root <워크스페이스 루트>/<폴더>
git -C <워크스페이스 루트>/<폴더> config core.hooksPath .githooks   # 커밋 전 검사
wb config get                                                          # 서비스 저장소가 보이는지 확인
```

- 서비스 저장소들과 같은 상위 폴더에 clone하면 서비스 저장소 위치를 따로 정하지 않아도 된다. 다른 곳이면 [PC별 설정](#pc별-설정-workbenchconfigjson)을 한다
- clone은 기본 브랜치에 둔다. 스킬은 기본 브랜치에서만 커밋한다

#### 새 문서 저장소 만들기

팀에 문서 저장소가 없을 때 한 사람이 만든다. 같은 팀이 둘을 만들면 보드가 갈라지므로 먼저 확인한다.

1. 만든다.
   ```bash
   wb init <폴더> --host gitlab --web https://gitlab.example.com --repo group/docs --set-data-root
   ```
   GitHub면 `wb init <폴더> --host github --repo owner/docs --set-data-root`다. 기본 브랜치가 `main`이 아니면 `--branch <이름>`을 붙인다.

   보드·기록 폴더, `projects.tsv` 머리, `workbench.config.json`, `.githooks/pre-commit`, 호스트에 맞는 CI 파일, `.gitattributes`, `README.md`를 만들고 `git init`과 `core.hooksPath` 설정까지 한다. 원격 연결과 커밋은 하지 않는다.
2. `projects.tsv`에 project를 한 줄씩 더한다([형식](#대응표-projectstsv)). task_id 키는 팀이 정한다.
3. `wb lint --all`로 확인한다.
4. 호스트에 빈 저장소를 만들고(비공개 권장) 연결해 push한다. 처음 한 번은 원격이 없어 git을 직접 쓴다. 그 뒤의 커밋은 스킬이 `wb sync`로 한다.
   ```bash
   git -C <폴더> remote add origin <주소>
   git -C <폴더> add -A
   git -C <폴더> commit -m "chore: workbench 문서 저장소 초기화"
   git -C <폴더> push -u origin main
   ```
5. 호스트 설정: 기본 브랜치에 직접 push 허용, CI 실행 확인. 문서 저장소를 읽을 수 있는 사람이 곧 보드를 볼 수 있는 사람이다.

## 설정 파일

예시는 [templates/samples/](templates/samples/)에 있다. 모두 생략할 수 있는 키는 생략하면 엔진이 기본값을 쓴다.

| 파일 | 위치 | 누가 쓰나 | 예시 |
|---|---|---|---|
| 공유 설정 | 문서 저장소 `workbench.config.json` (커밋한다) | `wb init`이 만들고, 팀이 손으로 고친다 | [workbench.config.json](templates/samples/workbench.config.json) |
| 대응표 | 문서 저장소 `projects.tsv` (커밋한다) | 팀이 손으로 고치거나, 사용자가 확인한 값으로 에이전트가 고친다 | [projects.tsv](templates/samples/projects.tsv) |
| PC별 설정 | `~/.workbench/config.json` (저장소 밖) | `wb config`가 쓴다. 손으로 고쳐도 된다 | [user-config.json](templates/samples/user-config.json) |

손으로 고친 문서 저장소 파일은 커밋 전 검사(`wb lint --staged`)와 CI가 검사한다. 비밀(토큰·비밀번호)은 어느 파일에도 넣지 않는다.

### 공유 설정 `workbench.config.json`

| 키 | 뜻 | 생략하면 |
|---|---|---|
| `formatVersion` | 문서 저장소가 따르는 형식 버전. 엔진보다 높으면 `wb`가 갱신을 안내하고 멈춘다 | 1 |
| `host.type` | `gitlab` 또는 `github`. 보드의 코드·파일 링크 형식 | 링크를 만들지 않는다 |
| `host.web` | 호스트 웹 주소. GitLab이면 필요하다 | GitHub면 `https://github.com` |
| `repo` | 호스트에서 문서 저장소의 경로(예: `group/docs`). 보드의 파일 링크에 쓴다 | 파일 링크가 없다 |
| `branch` | 기본 브랜치. 이슈·기록은 이 브랜치에만 커밋한다 | `main` |
| `docRoots` | 서비스 저장소 안 상시 문서 폴더 후보 | `src/main/resources/docs`, `docs` |
| `board.fetchIntervalSec` | 보드의 fetch 주기(초, 5 이상) | 30 |

정본과 나머지 키(`host.api`)는 [형식 문서의 "설정"](references/workbench-format.md#설정)에 있다.

### 대응표 `projects.tsv`

한 줄에 project 하나, 열 네 개를 **탭**으로 나눈다. `#`로 시작하는 줄은 주석이다.

```tsv
# project	key	repos	remote
app	APP	group/app	group/app
web	WEB	group/web-front,group/web-admin	group/web-front,group/web-admin
common	CMN	-	-
```

| 열 | 값 |
|---|---|
| project | 짧은 이름. 기록 폴더 `records/{project}/`가 된다 |
| key | task_id 접두사(`APP` → `APP-123`). 대문자로 시작하고 대문자·숫자만. 그 저장소의 기존 브랜치에 쓰던 키가 있으면 그대로 쓴다. 여러 project가 같은 키를 써도 된다 |
| repos | 서비스 저장소의 논리 경로: 워크스페이스 루트 기준 상대 경로(예: `group/app`). 여럿이면 쉼표. 저장소가 없는 project는 `-` |
| remote | `repos`와 같은 순서·개수로 호스트의 저장소 경로(`git remote get-url origin`에서 호스트와 `.git`을 뗀 값). 없는 자리는 `-` |

규칙의 정본은 [형식 문서의 "project와 키 추가"](references/workbench-format.md#project와-키-추가)다.

### PC별 설정 `~/.workbench/config.json`

| 상황 | 명령 | JSON 키 |
|---|---|---|
| 문서 저장소 위치 | `wb config set data-root <경로>` | `dataRoot` |
| 서비스 저장소를 문서 저장소와 다른 상위 폴더에 둠 | `wb config set workspace-root <경로>` | `workspaceRoot` |
| 저장소 하나만 다른 폴더에 둠 | `wb config set repo-path <projects.tsv의 논리 경로> <폴더>` | `repoPaths` (논리 경로 → 폴더) |
| 문서 저장소의 git 원격 이름이 `origin`이 아님 | `wb config set remote <이름>` | `remote` |
| 세션이 시작되면 보드를 띄우고 세션이 모두 끝나면 끄기([자세히](#세션과-함께-자동으로-띄우기)) | `wb config set board-autostart on` | `boardAutostart` (기본 `false`) |
| 지금 값과 출처, 이 PC에 없는 서비스 저장소 | `wb config get` | — |
| 값 지우기 | `wb config unset <키>` | — |

- 서비스 저장소 위치는 설정하지 않으면 `{문서 저장소의 상위 폴더}/{논리 경로}`다
- 환경변수 `WORKBENCH_ROOT`가 `dataRoot`보다, `WORKSPACE_ROOT`가 `workspaceRoot`보다 우선한다
- 손으로 고칠 때 Windows 경로는 JSON 문자열이므로 `\\`로 쓰거나 `/`로 쓴다

## 확인

1. `claude plugin list` — `workbench@fiveeyes`가 켜져 있다
2. 새 세션에서 `/workbench:`를 입력하면 스킬 목록이 보인다
3. 에이전트에게 "wb --help 실행해 줘" — `문서:` 줄에 문서 저장소 경로가, `엔진:` 줄에 설치 위치와 버전이 나온다
4. 에이전트에게 "wb lint --all 실행해 줘" — 오류가 0이다

## 보드

에이전트에게 **"보드 띄워 줘"**라고 하면 `wb board --open`을 실행한다. 보드는 백그라운드로 뜨고 브라우저가 열린다(기본 `http://127.0.0.1:47800/`). 끌 때는 "보드 꺼 줘"(`wb board --stop`)라고 한다.

- 보여 주는 것은 원격 기본 브랜치(`origin/<branch>`)다. 주기적으로 fetch하므로 다른 사람이 push한 이슈도 보인다. push 전 내용까지 보려면 "push 안 한 것도 보이게 띄워 줘"(`--worktree`)
- `127.0.0.1`에서만 듣고 인증이 없다. 이 PC의 사람만 볼 수 있다
- 이미 떠 있으면 새로 띄우지 않고 그 주소를 알린다. 포트를 바꾸려면 `--port <번호>`
- 터미널용 `wb`를 설치했으면 터미널에서 `wb board --open`으로도 띄운다. 이때는 그 터미널에서 돌고 Ctrl+C로 끝낸다
- 백그라운드 보드의 상태는 `~/.workbench/board.json`, 로그는 `~/.workbench/board.log`에 있다

### 세션과 함께 자동으로 띄우기

`wb config set board-autostart on`(또는 에이전트에게 "보드 자동 실행 켜 줘")을 하면, Claude Code 세션이 시작될 때 보드가 백그라운드로 뜨고 브라우저가 열린다. 이 PC의 Claude Code 세션이 모두 끝나면 보드가 스스로 꺼진다. 기본은 꺼져 있다.

- 브라우저는 보드를 새로 띄울 때만 열린다. 세션을 더 열어도 떠 있는 보드를 같이 쓰고 브라우저를 다시 열지 않는다
- 꺼지는 시점: 세션 시작 훅이 그 세션의 Claude Code 프로세스를 `~/.workbench/board-sessions/`에 적고, 보드가 5초마다 그 프로세스들이 살아 있는지 본다. 모두 없어지고 20초가 지나면 꺼진다. 그래서 `/exit`로 끝내도, 터미널 창을 그냥 닫아도 꺼진다. `/clear`처럼 세션이 바로 이어지면 꺼지지 않는다
- 비대화형 실행(`claude -p`, SDK)에는 띄우지 않는다
- 사람이나 에이전트가 따로 띄운 보드(`wb board --open`)는 세션이 끝나도 끄지 않는다. 자동으로 뜬 보드도 `wb board --stop`으로 바로 끌 수 있다
- 세션의 Claude Code 프로세스를 찾지 못하는 환경이면 종료 훅이 기록을 지울 때 꺼진다. 종료 훅도 돌지 못하면 그 기록은 24시간 뒤에 정리된다
- 끄기: `wb config set board-autostart off`

## 쓰는 법

| 스킬 | 이렇게 말하면 된다 |
|---|---|
| `/workbench:setup` | "workbench 설정해 줘", "문서 저장소 새로 만들어 줘", "서비스 저장소 위치 바꿔 줘" |
| `/workbench:new-task` | "이 작업 workbench 이슈로 만들어 줘. 유형은 feature" |
| `/workbench:update-task` | "APP-123 design으로 옮겨 줘", "완료 처리해", "제목 바꿔 줘" |
| `/workbench:archive-task` | "끝난 이슈 APP-120 보관해 줘" |
| `/workbench:groundwork` | "APP-123 현황 조사해서 정리해 줘", "제안서 써 줘", "설계 초안 써 줘" |
| `/workbench:plan` | "APP-123 작업 계획 세워 줘" |
| `/workbench:orchestrate` | "APP-123 계획까지 자동으로 진행해 줘" — 필요한 단계만 골라 Planning까지 멈추지 않고 진행하고, 결정은 이슈 폴더 `decisions.md`에 남긴다 |
| `/workbench:evaluate-decisions` | "APP-123 결정 평가할게. D-2 수정, 나머지 승인" |
| `/workbench:proposal-review` | "이 제안서 3관점으로 검토해 줘" |
| `/workbench:documentation` | "이 저장소 정책 문서 갱신해 줘", "끝난 이슈 기록을 저장소 문서로 옮겨 줘" |

- 보드를 바꾸는 스킬은 사람이 지시했을 때만 동작한다
- 스킬은 끝날 때 바꾼 파일만 문서 저장소의 기본 브랜치에 커밋·push한다
- 이슈 본문의 기본 틀은 없다. 스킬은 말한 내용만 정리해 두고, 그다음은 직접 고친다
- 단계와 스킬의 흐름은 [프로젝트 소개의 워크플로](https://github.com/JongWoong88/workbench-engine#워크플로)에 있다

## 터미널에서 `wb` 직접 쓰기

플러그인의 `wb`는 Claude Code 세션 안에서만 PATH에 있다. 터미널에서도 쓰려면 같은 패키지를 npm으로 설치한다.

```bash
npm i -g @fiveeyes/workbench-engine        # 설치하면 터미널에 wb가 생긴다
npx -y @fiveeyes/workbench-engine@^1 board --open   # 설치 없이 한 번만 실행
```

- 전역 설치는 플러그인과 따로 갱신된다: `npm update -g @fiveeyes/workbench-engine`. 둘의 버전이 달라도 1.x 안에서는 같은 문서 저장소를 다룰 수 있다. 문서 저장소가 더 새 형식이면 오래된 쪽이 갱신을 안내하고 멈춘다
- 전역 설치를 하면 터미널·IDE에서 한 커밋에도 커밋 전 검사가 돈다. 설치하지 않았으면 hook은 경고만 내고 통과시키고, push 뒤 CI가 검사한다
- 에이전트는 전역 설치와 상관없이 플러그인의 `wb`를 쓴다

## 사내 npm 미러

외부 npm 레지스트리에 닿지 못하는 환경은 미러를 쓴다. 미러가 이 패키지(`@fiveeyes/workbench-engine`)를 프록시해야 한다.

| 곳 | 설정 |
|---|---|
| PC(플러그인 설치·갱신, 전역 설치) | Claude Code는 사용자의 npm 설정으로 패키지를 받는다: `npm config set @fiveeyes:registry <미러 주소>` |
| 문서 저장소 CI | CI 변수 `NPM_CONFIG_REGISTRY=<미러 주소>`를 두거나, CI 파일의 `npx` 앞에 같은 환경변수를 둔다 |

## 갱신과 제거

- 갱신: 자동 갱신을 켰으면 할 일이 없다. 수동이면 `claude plugin update workbench@fiveeyes`. 열린 세션은 `/reload-plugins`
- 하위호환 갱신은 문서 저장소를 고치지 않는다. 문서 저장소가 더 새 형식이면 `wb`가 갱신을 안내하고 멈춘다
- 제거: `claude plugin uninstall workbench@fiveeyes`. 문서 저장소와 `~/.workbench/`는 그대로 남는다. 전역 설치를 했으면 `npm rm -g @fiveeyes/workbench-engine`

## 알아 둘 것

- **문서 저장소 clone은 기본 브랜치에 둔다.** 스킬은 기본 브랜치에서만 커밋하고, 다른 브랜치면 쓰기 전에 멈춘다
- **손으로 고친 파일이 있으면 스킬이 멈춘다.** 섞어 커밋하지 않기 위해서다. 그 편집을 먼저 커밋하거나 되돌린 뒤 다시 시킨다
- 커밋은 `fetch → commit → push` 순서로 한다. push가 거부되면 원격 변경 위에 다시 올려 한 번 더 시도한다. 되돌리지 못하면 push하지 않고 알린다
- 스킬은 필요한 명령을 미리 승인받아 승인 창 없이 돈다. 다만 검토 에이전트를 부르는 스킬(`groundwork`, `plan`, `proposal-review`)은 검토가 끝난 뒤의 수정·커밋에서 승인 창이 한 번 뜰 수 있다. `setup`은 git clone·push 같은 명령마다 승인을 묻는다. 매번 승인하기 번거로우면 사용자 설정에 `Bash(wb *)` 허용 규칙을 직접 넣어도 된다 — 플러그인은 사용자 설정을 건드리지 않는다
- 플러그인이 막을 수 없는 이 PC의 설정: 권한 deny 규칙, 관리형 정책, 사용자 훅, 사용자 `CLAUDE.md`. 이것들이 스킬과 부딪히면 그 설정이 이긴다

## 문제 해결

| 메시지 | 뜻 | 할 일 |
|---|---|---|
| `ENV-DATA-ROOT` | 문서 저장소 위치가 정해지지 않았거나 문서 저장소가 아니다 | "workbench 설정해 줘", 또는 `wb config set data-root <경로>` |
| `ENV-USER-CONFIG` | `~/.workbench/config.json`을 JSON으로 읽을 수 없다 | 파일을 고치거나 지우고 `wb config set`으로 다시 만든다 |
| `ENV-FORMAT-NEWER` | 문서 저장소가 이 엔진보다 새 형식이다 | 플러그인을 갱신한다 |
| `SYNC-NOT-MAIN` | 문서 저장소 clone이 다른 브랜치에 있다 | 브랜치 작업을 마치고 기본 브랜치로 돌아간다 |
| `SYNC-DIRTY-TARGET`, `SYNC-STAGED-OTHER` | 손으로 고친 내용이 있다 | 그 편집을 커밋하거나 되돌린다 |
| `SYNC-CONFLICT`, `SYNC-DIVERGED` | 원격과 충돌했다 | 직접 정리한다. 번호가 겹쳤으면(같은 이슈 파일) 한쪽 번호를 새로 발급한다 |
| `SYNC-AUTH` | 원격 저장소에 접근하지 못했다 | 터미널에서 `git fetch`로 한 번 로그인한다 |
| `BOARD-NO-REF` | 원격 기본 브랜치를 읽지 못했다 | 문서 저장소에서 `git fetch`가 되는지 본다. 아직 push하지 않은 새 저장소면 push하거나 `--worktree`로 띄운다 |
| `BOARD-PORT-BUSY` | 보드 포트를 다른 프로그램이 쓴다 | `--port <다른 번호>`로 띄운다 |
| `BOARD-START-TIMEOUT`, `BOARD-START-FAILED` | 백그라운드 보드가 뜨지 못했다 | `~/.workbench/board.log`를 본다. fetch가 오래 걸리면 `--no-fetch` |
| `BOARD-UI-MISSING` | 보드 화면 파일이 없다 | 플러그인을 다시 설치한다 |
| 터미널에서 `wb: command not found` | 터미널에는 `wb`가 없다(정상) | 에이전트에게 시키거나 [터미널용으로 설치](#터미널에서-wb-직접-쓰기)한다 |
| 세션 안에서 `wb: command not found` | 플러그인이 꺼져 있거나 PowerShell 도구에서 찾지 못했다 | `claude plugin list` 확인. 설치 직후면 새 세션이나 `/reload-plugins`. PowerShell이면 `wb.cmd` 전체 경로로 실행한다 |
