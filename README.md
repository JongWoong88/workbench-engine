# workbench

여러 저장소에 걸친 작업을 **하나의 칸반 보드와 기록 문서**로 관리하는 Claude Code 플러그인이다. 이슈와 기록은 팀이 가진 git 저장소(문서 저장소)에 두고, AI 에이전트와 사람이 같은 clone을 본다. 에이전트는 정해진 규칙대로 이슈를 발급하고, 단계별 기록(조사·제안·설계·작업 계획)을 쓰고, 산출물을 이슈에 링크한다.

- 이슈: `board/tasks/{task_id}.md` — 프론트매터(컬럼·작성자·산출물·이력)와 본문
- 기록: `records/{project}/{task_id}/*.md` — 특정 시점의 작업 문서
- 대응표: `projects.tsv` — project ↔ task_id 키 ↔ 서비스 저장소
- 보드: `wb board`가 문서 저장소 clone을 읽어 `127.0.0.1`에 칸반을 띄운다. 인증과 서버가 필요 없다

## 설치

준비물: Node 22 이상, git, Claude Code

```bash
claude plugin marketplace add JongWoong88/workbench-engine
claude plugin install workbench@fiveeyes --scope user
wb config set data-root <문서 저장소 clone 경로>
```

자세한 절차와 PC별 설정, 스킬 쓰는 법은 [plugin/README.md](plugin/README.md)에 있다. 형식 규칙은 [plugin/references/workbench-format.md](plugin/references/workbench-format.md)다.

## 문서 저장소

문서 저장소는 다음을 가진 git 저장소다.

| 파일 | 내용 |
|---|---|
| `board/tasks/` | 이슈 파일 |
| `records/` | 기록 문서 |
| `projects.tsv` | `project`, `key`, `repos`, `remote` 네 열(탭 구분) |
| `workbench.config.json` | 공유 설정(호스트·기본 브랜치 등). 생략할 수 있다 |
| `.githooks/pre-commit` | 커밋 전 검사. [plugin/templates/githooks/pre-commit](plugin/templates/githooks/pre-commit)을 복사하고 `git config core.hooksPath .githooks` |
| CI 파일 | 로컬 검사를 거치지 않은 push를 잡는 lint. [GitLab](plugin/templates/ci/gitlab-ci.yml), [GitHub](plugin/templates/ci/github-lint.yml) 템플릿 |

## 갱신

하위호환 갱신은 플러그인 갱신만으로 받고 문서 저장소는 고치지 않는다. 자동 갱신을 켜 두기를 권한다.

## 개발

엔진 개발은 [CLAUDE.md](CLAUDE.md)를 본다.

## 라이선스

[MIT](LICENSE). 포함한 외부 라이브러리의 고지는 게시 패키지의 `THIRD_PARTY_NOTICES.md`에 있다.
