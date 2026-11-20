# CLAUDE.md

workbench 엔진 저장소다. 작업 보드 이슈와 기록 문서를 git 문서 저장소에 두고 다루는 Claude Code 플러그인(스킬·`wb` 명령·lint·로컬 보드)을 개발하고 게시한다. 사용자의 이슈·기록은 이 저장소에 없다. 각 팀의 문서 저장소에 있다.

- 형식 규칙의 정본: [plugin/references/workbench-format.md](plugin/references/workbench-format.md)
- 스킬이 따르는 이용 규칙: [plugin/references/workbench-rules.md](plugin/references/workbench-rules.md)
- 사용자 안내: [README.md](README.md)(왜 필요한가·워크플로·빠른 시작), [plugin/README.md](plugin/README.md)(설치·구성·설정·문제 해결 — 게시 패키지의 README). 같은 내용을 두 곳에 쓰지 않는다
- CLAUDE.md는 엔진 개발용이다. 게시 패키지에 넣지 않는다

## 구성

| 경로 | 내용 | 설치물에 |
|---|---|---|
| `plugin/` | 플러그인 원본. `skills/`, `agents/`, `hooks/`, `references/`, `board.yml`, `templates/`(문서 저장소 hook·CI, 설정 예시 `samples/`) | 들어간다 |
| `plugin/cli/` | `wb` 명령 소스. 게시할 때 `bin/wb.mjs` 한 파일로 묶는다 | 묶음으로 |
| `plugin/bin/` | `wb` 진입점(`wb`, `wb.cmd`, `wb.mjs`) | 들어간다 |
| `site/` | 보드 화면 원본. `npm run board:build`가 `plugin/board-ui/`로 묶는다 | 묶음으로 |
| `bin/` | 개발 도구: `build-site`, `build-package`, `replay-*` | 들어가지 않는다 |
| `test/` | `npm test` | 들어가지 않는다 |
| `.claude-plugin/marketplace.json` | 마켓플레이스. 플러그인은 npm 패키지를 받는다 | — |
| `.github/workflows/` | 시험(`ci.yml`), 게시(`release.yml`) | — |

## 개발

```bash
npm ci
npm test                     # 시험 (사이트 화면은 jsdom)
npm run board:build          # 보드 화면 묶음 → plugin/board-ui/ (wb board가 서빙한다)
npm run package:build        # 게시 패키지 → dist/package/
claude --plugin-dir ./plugin # 이 세션에만 소스 플러그인을 올린다
node plugin/bin/wb.mjs --help
```

- 문서 저장소가 있어야 하는 명령은 `WORKBENCH_ROOT=<문서 저장소>`나 `wb config set data-root`로 위치를 준다. 시험은 임시 작업 공간을 만들어 쓰고 실제 홈 설정을 건드리지 않는다(`WORKBENCH_CONFIG_DIR`).
- `wb board`는 터미널이면 그 자리에서 돌고, 터미널이 아니면(에이전트) 백그라운드로 띄우고 바로 돌아온다(`--stop`으로 끈다). 시험에서 터미널 없이 그 자리에서 돌려야 할 때만 `WORKBENCH_BOARD_ALLOW_NONTTY=1`을 준다.
- `wb`는 에이전트용 명령이다. 사용자 문서는 구성·보드를 포함한 모든 일을 에이전트에게 시키는 것을 기본으로 안내하고, 터미널 사용은 선택(`npm i -g`)으로 안내한다.

## 설치물 규칙

| 규칙 | 강도 |
|---|---|
| 설치물은 Node 내장 모듈과 설치물에 포함한 파일만 쓴다. 런타임 npm 의존을 두지 않는다. `build-package`가 검사한다 | 반드시 |
| 설치물 안에서 설치물 밖 파일을 참조하지 않는다. 스킬은 `${CLAUDE_PLUGIN_ROOT}/..`를 가리키지 않는다(시험이 검사한다) | 반드시 |
| 설치 폴더에 상태를 쓰지 않는다. PC별 값은 `~/.workbench/config.json`, 팀 공유 값은 문서 저장소 `workbench.config.json`에 둔다 | 반드시 |
| 인스턴스 값(특정 팀의 서버 주소·저장소 경로·이슈 키)을 엔진에 넣지 않는다. 예시는 일반 값(`APP-123`, `ws/app`)으로 쓴다 | 반드시 |
| 패키지의 `bin`은 `wb` 하나다. 문서 저장소 CI가 `npx -y <패키지>@^1 lint --all`로 부른다 | 반드시 |

## 규칙의 정본

형식 사실 하나에 정본은 하나다. 나머지는 정본을 불러 쓰거나(코드), 링크하거나(문서), 시험으로 정본과 대조한다. 규칙을 읽는 agent가 따를 수 있는 안내(문서 예시, lint 수정 안내)는 모두 lint 하나를 통과해야 한다.

| 사실 | 정본 | 지키는 방법 | 강도 |
|---|---|---|---|
| 마크다운 제목·앵커·ID 항목 문법 | `plugin/cli/lib/model/markdown.mjs` | 제목을 읽는 코드는 이 모듈만 쓴다. 모듈 밖 제목 정규식은 `test/coherence.test.mjs`가 막는다 | 반드시 |
| 앵커·링크 일반 규칙 | `workbench-format.md` "링크 규칙" | 영역 문서(`decisions-format.md` 등)는 일반 규칙을 다시 쓰지 않고 링크한다 | 반드시 |
| 문서 저장소 파일 형식 검사 | `wb lint` 규칙 | 형식 검사를 새 명령에 따로 두지 않는다. 다른 명령은 lint와 같은 검사 함수를 부른다(`decision-stats --check` ↔ `DEC-*`) | 반드시 |
| 기계적으로 고칠 수 있는 위반의 수정 방법 | finding의 `edits` | 시험이 `edits`를 적용하고 lint를 다시 돌려 새 위반이 없는지 본다 | 반드시 |
| 문서 저장소 파일의 형식 예시 | 예시 코드 블록 | ```` ```markdown wb-example="<이슈 폴더 안 파일명>" ````으로 쓴다. 시험이 lint한다. 문장 속 인라인 예시 링크는 ID 항목을 slug로 가리키지 않는다 | 반드시 |
| 플러그인 문서끼리의 앵커 링크 | 대상 문서 제목 | 시험이 대상 문서에 그 앵커가 있는지 본다 | 반드시 |

## 배포선과 호환 규칙

| 브랜치 | 들어가는 변경 |
|---|---|
| `main` | 개발 |
| `v1` | 아래 하위호환 규칙을 지키는 변경만. `main`에서 시험한 뒤 fast-forward한다. push하면 `release.yml`이 npm `1.x`를 게시한다 |
| `v2` … | 깨지는 변경이 생기면 새로 연다 |

"하위호환 변경"은 문서 저장소를 고치지 않아도 `lint --all` 통과, 보드 표시, 스킬 동작이 그대로인 변경이다.

| K | 규칙 |
|---|---|
| K-1 | `v1` 배포선과 npm `1.x`에는 하위호환 변경만 넣는다 |
| K-2 | 새 필드·열·설정 키는 생략할 수 있다. 생략하면 엔진이 기본값을 정한다 |
| K-3 | 새 lint 오류 규칙(또는 기존 규칙을 강화하는 변경)은 `FORMAT_VERSION`(`plugin/cli/lib/shared-config.mjs`)을 올리고 `RULE_SINCE`(`plugin/cli/lib/lint-rules.mjs`)에 도입 버전을 적는다. 문서 저장소의 `formatVersion`이 낮으면 경고로 나온다 |
| K-4 | 필드·열·설정 키 이름을 바꾸면 옛 이름도 읽는다 |
| K-5 | 깨지는 변경은 새 배포선, `FORMAT_VERSION` 증가, 이전 명령을 함께 낸다. 이때만 사용자 문서가 바뀐다 |
| K-6 | 런타임 npm 의존을 두지 않는다. CLI는 한 파일로 묶는다 |
| K-7 | 문서 저장소 CI가 쓰는 `lint --all`의 인자, `WORKBENCH_ROOT`, 종료 코드는 `1.x` 안에서 유지한다(`test/package.test.mjs`) |
| K-8 | 문서 저장소의 `formatVersion`이 엔진이 아는 값보다 높으면 `wb`는 갱신을 안내하고 종료 코드 3으로 멈춘다 |
| K-9 | 릴리스마다 `package.json`과 `plugin/.claude-plugin/plugin.json`의 `version`을 같은 값으로 올린다. 버전이 같으면 게시하지 않는다 |

## 게시

- 게시는 `release.yml`만 한다. npm 신뢰 게시(OIDC)를 쓰고 저장 토큰을 두지 않는다. 개인 계정 토큰으로 게시하지 않는다.
