// projects.tsv 읽기: 깃랩 경로 열
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjects } from '../plugin/cli/lib/workbench.mjs';

const HEAD = '# project\tkey\trepos\tgitlab\n';

test('깃랩 열을 repos와 같은 순서로 짝짓는다', () => {
  const p = parseProjects(`${HEAD}crawler\tLIB\tother/a,other/b\tjp/batch/a,jp/batch/b\ncommon\tKEYC\t-\t-\n`);
  const crawler = p.byProject.get('crawler');
  assert.deepEqual(crawler.gitlab, ['jp/batch/a', 'jp/batch/b']);
  assert.equal(crawler.gitlabMismatch, false);
  assert.equal(p.gitlabByRepo.get('other/b'), 'jp/batch/b');
  assert.deepEqual(p.byProject.get('common').gitlab, []);
  assert.equal(p.byProject.get('common').gitlabMismatch, false);
});

test('넷째 열은 위치로 읽는다: 머리 주석이 remote여도 같고, 새 이름(remote*)과 옛 이름(gitlab*)이 같은 값이다', () => {
  const p = parseProjects('# project\tkey\trepos\tremote\ncrawler\tLIB\tws/a,ws/b\tgrp/a,-\n');
  const row = p.byProject.get('crawler');
  assert.deepEqual(row.remote, ['grp/a', null]);
  assert.deepEqual(row.remote, row.gitlab);
  assert.equal(row.hasRemoteColumn, true);
  assert.equal(row.remoteMismatch, false);
  assert.equal(p.remoteByRepo.get('ws/a'), 'grp/a');
});

test('항목이 `-`면 깃랩 경로가 없다', () => {
  const p = parseProjects(`${HEAD}event\tEV\tws/event,ws/web\t-,grp/web\n`);
  assert.deepEqual(p.byProject.get('event').gitlab, [null, 'grp/web']);
  assert.equal(p.gitlabByRepo.has('ws/event'), false);
});

test('항목 수가 다르면 gitlabMismatch이고 경로를 쓰지 않는다', () => {
  const p = parseProjects(`${HEAD}x\tX\ta/r1,a/r2\tg/r1\ny\tY\t-\tg/y\n`);
  assert.equal(p.byProject.get('x').gitlabMismatch, true);
  assert.deepEqual(p.byProject.get('x').gitlab, [null, null]);
  assert.equal(p.byProject.get('y').gitlabMismatch, true);
});

test('깃랩 열이 없는 옛 3열 형식도 읽는다', () => {
  const p = parseProjects('# project\tkey\trepos\nalpha\tKEYA\torg/alpha-repo\n');
  const alpha = p.byProject.get('alpha');
  assert.deepEqual(alpha.repos, ['org/alpha-repo']);
  assert.deepEqual(alpha.gitlab, [null]);
  assert.equal(alpha.hasGitlabColumn, false);
  assert.equal(alpha.gitlabMismatch, false);
});
