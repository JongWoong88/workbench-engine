// 순수 모델 모듈(bin/lib/model/): 보드 사이트 번들이 함께 쓰므로 node: 모듈에 의존하지 않는다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoardText } from '../plugin/cli/lib/model/board.mjs';
import { ParseError } from '../plugin/cli/lib/model/errors.mjs';
import { parseBoard } from '../plugin/cli/lib/board.mjs';

const MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'cli', 'lib', 'model');

test('model/의 import는 같은 폴더 모듈과 yaml 패키지뿐이다', () => {
  for (const name of fs.readdirSync(MODEL).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(MODEL, name), 'utf8');
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\b[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      assert.ok(spec === 'yaml' || /^\.\/[\w-]+\.mjs$/.test(spec), `${name}: ${spec}`);
    }
  }
});

test('board.yml 오류는 model에서 ParseError, bin/에서 같은 코드의 Rejection이다', () => {
  assert.throws(() => parseBoardText('columns: [\n'), (e) => e instanceof ParseError && e.code === 'BOARD-CONFIG' && e.problems.length === 0);
  assert.throws(() => parseBoardText('columns: []\n'), (e) => e instanceof ParseError && e.problems.length === 1);
  assert.throws(() => parseBoard('columns: [\n'), (e) => e.code === 'BOARD-CONFIG' && e.owner === 'board' && e.fix[0] === 'YAML 문법 오류를 고친다');
  assert.throws(() => parseBoard('columns: []\n'), (e) => e.code === 'BOARD-CONFIG' && e.fix.at(-1).includes('workbench-format.md'));
});
