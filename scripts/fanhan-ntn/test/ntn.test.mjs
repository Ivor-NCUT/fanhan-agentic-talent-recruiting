import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempWorkspace, page, relation } from './helpers.mjs';

const load = async (ws) => {
  process.env.FANHAN_NTN_BIN = ws.bin;
  process.env.FAKE_NTN_STATE = ws.stateFile;
  return import('../src/ntn.mjs');
};

test('queryAll follows every cursor page', async () => {
  const ws = tempWorkspace();
  ws.writeState({
    datasets: {
      ds: { pages: [[{ id: 'a' }], [{ id: 'b' }], [{ id: 'c' }]] },
    },
  });
  const { queryAll } = await load(ws);
  const rows = await queryAll('ds', { pageSize: 1 });
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c']);
  assert.ok(ws.readState().calls.filter((c) => c[0] === 'datasources').length >= 3);
});

test('queryAll rejects incomplete request_status instead of publishing a partial pool', async () => {
  const ws = tempWorkspace();
  ws.writeState({
    datasets: {
      ds: { pages: [[{ id: 'a' }]], requestStatus: [{ type: 'incomplete', incomplete_reason: 'rate_limit' }] },
    },
  });
  const { queryAll } = await load(ws);
  await assert.rejects(() => queryAll('ds'), /incomplete|不完整|rate_limit/i);
});

test('queryAll retries rate limits and transient failures', async () => {
  const ws = tempWorkspace();
  ws.writeState({
    datasets: {
      ds: { pages: [[{ id: 'a' }]], rateLimitAt: [{ status: 429, message: '429 too many requests' }], rateLimitTimes: 1 },
    },
  });
  const { queryAll } = await load(ws);
  const rows = await queryAll('ds');
  assert.deepEqual(rows.map((r) => r.id), ['a']);
  const calls = ws.readState().calls.filter((c) => c[0] === 'datasources');
  assert.ok(calls.length >= 2);
});

test('readRelation paginates the relation property beyond the inline 25-item window', async () => {
  const ws = tempWorkspace();
  const ids = Array.from({ length: 30 }, (_, i) => `id-${i}`);
  ws.writeState({
    pages: {
      'cand-1': page('cand-1', '甲', {
        properties: { '匹配的职位': relation(ids.slice(0, 25), { hasMore: true }) },
      }),
    },
    relations: { 'cand-1': { '匹配的职位': { ids } } },
  });
  const { readRelation } = await load(ws);
  const rel = await readRelation('cand-1', '匹配的职位', { pageSize: 10 });
  assert.equal(rel.ids.length, 30);
  assert.equal(rel.paginated, true);
});

test('readRelation fails closed when the relation property is missing', async () => {
  const ws = tempWorkspace();
  ws.writeState({ pages: { 'cand-1': page('cand-1', '甲') } });
  const { readRelation } = await load(ws);
  await assert.rejects(() => readRelation('cand-1', '匹配的职位'), /属性|property|relation/i);
});

test('local lock is exclusive and can be released', async () => {
  const ws = tempWorkspace();
  const { acquireLock } = await load(ws);
  const dir = path.join(ws.root, 'lock-dir');
  fs.mkdirSync(dir, { recursive: true });
  const release = acquireLock(dir, 'link');
  assert.equal(typeof release, 'function');
  assert.throws(() => acquireLock(dir, 'link'), /锁|lock/i);
  release();
  const again = acquireLock(dir, 'link');
  again();
});
