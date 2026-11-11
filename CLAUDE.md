# CLAUDE.md

workbench 엔진 저장소다. 작업 보드 이슈와 기록 문서를 git 문서 저장소에 두고 다루는 Claude Code 플러그인(스킬·`wb` 명령·lint·로컬 보드)을 개발하고 게시한다. 사용자의 이슈·기록은 이 저장소에 없다. 각 팀의 문서 저장소에 있다.

- 형식 규칙의 정본: [plugin/references/workbench-format.md](plugin/references/workbench-format.md)
- 스킬이 따르는 이용 규칙: [plugin/references/workbench-rules.md](plugin/references/workbench-rules.md)
- 사용자 안내: [README.md](README.md), [plugin/README.md](plugin/README.md)

## 구성

| 경로 | 내용 | 설치물에 |
|---|---|---|
| `plugin/` | 플러그인 원본. `skills/`, `agents/`, `hooks/`, `references/`, `board.yml`, `templates/`(문서 저장소 hook·CI) | 들어간다 |
| `plugin/cli/` | `wb` 명령 소스. 게시할 때 `bin/wb.mjs` 한 파일로 묶는다 | 묶음으로 |
| `plugin/bin/` | `wb` 진입점(`wb`, `wb.cmd`, `wb.mjs`) | 들어간다 |
| `site/` | 보드 화면 원본. `npm run board:build`가 `plugin/board-ui/`로 묶는다 | 묶음으로 |
| `bin/` | 개발 도구: `build-site`, `build-package`, `check-public`, `replay-*` | 들어가지 않는다 |
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
- `wb board`는 사람이 터미널에서 띄운다. 터미널이 아닌 곳에서 시험할 때만 `WORKBENCH_BOARD_ALLOW_NONTTY=1`을 준다.

## 설치물 규칙

| 규칙 | 강도 |
|---|---|
| 설치물은 Node 내장 모듈과 설치물에 포함한 파일만 쓴다. 런타임 npm 의존을 두지 않는다. `build-package`가 검사한다 | 반드시 |
| 설치물 안에서 설치물 밖 파일을 참조하지 않는다. 스킬은 `${CLAUDE_PLUGIN_ROOT}/..`를 가리키지 않는다(시험이 검사한다) | 반드시 |
| 설치 폴더에 상태를 쓰지 않는다. PC별 값은 `~/.workbench/config.json`, 팀 공유 값은 문서 저장소 `workbench.config.json`에 둔다 | 반드시 |
| 인스턴스 값(특정 팀의 서버 주소·저장소 경로·이슈 키)을 엔진에 넣지 않는다. 예시는 일반 값(`APP-123`, `ws/app`)으로 쓴다 | 반드시 |
| 패키지의 `bin`은 `wb` 하나다. 문서 저장소 CI가 `npx -y <패키지>@^1 lint --all`로 부른다 | 반드시 |

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
- 공개하기 전에 금지어 검사를 돌린다: `node bin/check-public.mjs --deny <금지어 파일> --untracked [--commits]`. 금지어 목록은 이 저장소에 넣지 않는다.
