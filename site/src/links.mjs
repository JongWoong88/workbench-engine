// 기록·이슈 본문의 상대 링크를 보드 주소로 푼다. 규칙: 형식 문서(references/workbench-format.md) "링크 규칙"
// 경로는 문서 저장소 루트 기준이다. 저장소 링크(`../{논리 경로}/…`)는 projects.tsv의 remote 열로 호스트 주소가 된다.
// 호스트 웹 주소의 형식(gitlab `/-/blob/`, github `/blob/`)은 hostUrls 한 곳에서만 만든다.

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/)/i;
const TASK_FILE = /^board\/tasks\/([A-Z][A-Z0-9]*-\d+)\.md$/;
const SHA = /@([0-9a-f]{6,40})\s*$/;

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** posix 경로 정규화. 루트 위로 올라가는 `..`는 앞에 남긴다 */
export function normalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..' && out.length && out.at(-1) !== '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** 웹 주소의 경로 부분. 세그먼트마다 인코딩한다(한글·공백·#·?) */
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/**
 * 호스트별 웹 주소 만들기. host: { type: 'gitlab'|'github', web }. 설정이 없으면 null(링크를 만들지 않는다)
 * @return {{ repo(path): string, blob(path, ref, file): string, tree(path, branch): string } | null}
 */
export function hostUrls(host) {
  if (!host || !host.web || !['gitlab', 'github'].includes(host.type)) return null;
  const web = String(host.web).replace(/\/+$/, '');
  const sep = host.type === 'gitlab' ? '/-/' : '/';
  return {
    repo: (p) => `${web}/${p}`,
    blob: (p, ref, file) => `${web}/${p}${sep}blob/${encodePath(ref)}/${encodePath(file)}`,
    tree: (p, branch) => `${web}/${p}${sep}tree/${encodePath(branch)}`,
  };
}

/**
 * 기록 프론트매터 base → { 저장소 경로: 커밋 }. `main@abc`(저장소 하나) 또는 { 이름: branch@sha }.
 * none·unknown·모호하면 비운다. projects: model/projects.mjs parseProjects 결과
 */
export function parseBase(base, repos, projects) {
  const byName = new Map();
  for (const r of projects.rows) for (const p of r.repos) if (!byName.has(p.split('/').at(-1))) byName.set(p.split('/').at(-1), p);
  const sha = (v) => (SHA.exec(String(v)) || [])[1] ?? null;
  const out = {};
  if (base && typeof base === 'object' && !Array.isArray(base)) {
    for (const [name, v] of Object.entries(base)) {
      const path = byName.get(String(name).split('(')[0].trim());
      if (path && sha(v)) out[path] = sha(v);
    }
  } else if (typeof base === 'string' && (repos ?? []).length === 1 && sha(base)) {
    const path = byName.get(String(repos[0]));
    if (path) out[path] = sha(base);
  }
  return out;
}

/**
 * 링크 하나를 푼다. 결과 kind:
 *  - keep: 바꾸지 않는다(절대 주소, 같은 문서 앵커)
 *  - record: records/ 아래 마크다운 기록(L-1) — { path, anchor }
 *  - task: 보드 이슈(L-2) — { id }
 *  - host: 호스트 파일 보기(L-1 비-md, L-3, L-4) — { url|null, path? } (path: 문서 저장소 안의 파일일 때 그 경로. url은 호스트 설정이 없으면 null)
 *  - unresolved: 풀 수 없다(L-5) — { warning }
 * ctx: { urls(hostUrls 결과|null), repo(문서 저장소의 호스트 경로|null), commit, projects }. shas: parseBase 결과
 */
export function resolveHref(href, srcRel, ctx, shas = {}) {
  if (!href || href.startsWith('#') || EXTERNAL.test(href)) return { kind: 'keep' };
  const hashAt = href.indexOf('#');
  const rawPath = hashAt < 0 ? href : href.slice(0, hashAt);
  const anchor = hashAt < 0 ? '' : decode(href.slice(hashAt + 1));
  const suffix = anchor ? `#${encodeURIComponent(anchor)}` : '';
  const target = normalize(`${dirname(srcRel)}/${decode(rawPath)}`);
  if (!target.startsWith('../')) {
    if (target.startsWith('records/') && target.endsWith('.md')) return { kind: 'record', path: target, anchor };
    const m = TASK_FILE.exec(target);
    if (m) return { kind: 'task', id: m[1] };
    return { kind: 'host', path: target, url: ctx.urls && ctx.repo ? `${ctx.urls.blob(ctx.repo, ctx.commit, target)}${suffix}` : null };
  }
  const parts = target.split('/');
  const hops = parts.filter((s) => s === '..').length;
  const rest = parts.slice(hops).join('/');
  if (hops === 1) {
    // 저장소 논리 경로는 projects.tsv의 repos 중 가장 긴 접두다(단계 수가 정해져 있지 않다)
    const repo = [...ctx.projects.allRepos].sort((a, b) => b.length - a.length).find((r) => rest.startsWith(`${r}/`));
    const remote = repo ? ctx.projects.remoteByRepo.get(repo) : null;
    if (remote && ctx.urls) return { kind: 'host', url: `${ctx.urls.blob(remote, shas[repo] ?? 'HEAD', rest.slice(repo.length + 1))}${suffix}` };
    if (repo && !ctx.urls) return { kind: 'unresolved', warning: `${srcRel}: 호스트 설정(workbench.config.json host)이 없어 저장소 링크를 그대로 둔다: ${href}` };
    if (repo) return { kind: 'unresolved', warning: `${srcRel}: remote 경로를 모르는 저장소 링크를 그대로 둔다: ${href} (${repo})` };
  }
  return { kind: 'unresolved', warning: `${srcRel}: 풀 수 없는 링크를 그대로 둔다: ${href}` };
}
