// projects.tsv의 순수 파서. node: 모듈을 쓰지 않는다 — bin/과 보드 화면(브라우저 번들)가 함께 쓴다.
// 열: project, key, repos, remote. remote는 repos와 같은 순서의 호스트 저장소 경로이고, 항목이 `-`면 경로 없음(링크 변환 안 함).
// 열은 위치로 읽는다. 넷째 열의 옛 이름 gitlab도 같다(머리 주석만 다르다). 넷째 열이 없는 옛 3열 형식도 읽는다.
// gitlab·hasGitlabColumn·gitlabMismatch·gitlabByRepo는 옛 이름이다. 새 코드는 remote 쪽을 쓴다
const items = (s) => (s ?? '-').split(',').map((x) => x.trim()).filter(Boolean);

export function parseProjects(text) {
  const rows = text.replace(/\r\n/g, '\n').split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => l.trim() && !l.startsWith('#'))
    .map(([l, line]) => {
      const [project, key, reposCol, gitlabCol] = l.split('\t').map((s) => s.trim());
      const rawRepos = items(reposCol);
      const rawGitlab = gitlabCol === undefined ? null : items(gitlabCol);
      const repos = rawRepos.filter((s) => s !== '-');
      // repos가 없는 project(`-`)는 gitlab도 `-` 하나다
      const gitlabMismatch = rawGitlab !== null && (repos.length ? rawGitlab.length !== repos.length : rawGitlab.some((g) => g !== '-'));
      const gitlab = repos.map((_, i) => (rawGitlab && !gitlabMismatch && rawGitlab[i] !== '-' ? rawGitlab[i] : null));
      return { project, key, line, repos, remote: gitlab, hasRemoteColumn: rawGitlab !== null, remoteMismatch: gitlabMismatch, gitlab, hasGitlabColumn: rawGitlab !== null, gitlabMismatch };
    });
  const byProject = new Map(rows.map((r) => [r.project, r]));
  const allRepos = [...new Set(rows.flatMap((r) => r.repos))];
  const gitlabByRepo = new Map();
  for (const r of rows) r.repos.forEach((repo, i) => { if (r.gitlab[i] && !gitlabByRepo.has(repo)) gitlabByRepo.set(repo, r.gitlab[i]); });
  return { rows, byProject, allRepos, remoteByRepo: gitlabByRepo, gitlabByRepo, names: rows.map((r) => r.project) };
}
