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

test('readRelation paginates the relation property beyond the inline 25-item window without using outer property-item IDs', async () => {
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
  assert.deepEqual(rel.ids, ids);
  assert.equal(rel.paginated, true);
  assert.ok(!rel.ids.includes('property-item-outer'));
});

test('readRelation preserves more than 100 relations and follows every property-item page', async () => {
  const ws = tempWorkspace();
  const ids = Array.from({ length: 130 }, (_, i) => `id-${i}`);
  ws.writeState({
    pages: {
      'cand-1': page('cand-1', '甲', {
        properties: { '匹配的职位': relation(ids.slice(0, 25), { hasMore: true }) },
      }),
    },
    relations: { 'cand-1': { '匹配的职位': { ids } } },
  });
  const { readRelation } = await load(ws);
  const rel = await readRelation('cand-1', '匹配的职位', { pageSize: 40 });
  assert.equal(rel.ids.length, 130);
  assert.deepEqual(rel.ids, ids);
  assert.ok(!rel.ids.includes('property-item-outer'));
});

test('readRelation tolerates an already percent-encoded property id without double encoding', async () => {
  const ws = tempWorkspace();
  const ids = Array.from({ length: 30 }, (_, i) => `id-${i}`);
  ws.writeState({
    pages: {
      'cand-1': page('cand-1', '甲', {
        properties: { '匹配的职位': relation(ids.slice(0, 25), { hasMore: true, id: 'rel%2Fid' }) },
      }),
    },
    relations: { 'cand-1': { '匹配的职位': { ids } } },
  });
  const { readRelation } = await load(ws);
  const rel = await readRelation('cand-1', '匹配的职位', { pageSize: 10 });
  assert.equal(rel.ids.length, 30);
});

test('readRelation fails closed on property-item results without a nested related page id', async () => {
  const ws = tempWorkspace();
  const ids = Array.from({ length: 30 }, (_, i) => `id-${i}`);
  ws.writeState({
    pages: {
      'cand-1': page('cand-1', '甲', {
        properties: { '匹配的职位': relation(ids.slice(0, 25), { hasMore: true }) },
      }),
    },
    relations: { 'cand-1': { '匹配的职位': { ids, malformed: true } } },
  });
  const { readRelation } = await load(ws);
  await assert.rejects(() => readRelation('cand-1', '匹配的职位', { pageSize: 10 }), /malformed|relation|关系|格式/i);
});

test('readRelation fails closed on malformed inline relation entries', async () => {
  const ws = tempWorkspace();
  ws.writeState({
    pages: {
      'cand-1': page('cand-1', '甲', {
        properties: {
          '匹配的职位': { id: 'rel', type: 'relation', relation: [{ object: 'page' }], has_more: false },
        },
      }),
    },
  });
  const { readRelation } = await load(ws);
  await assert.rejects(() => readRelation('cand-1', '匹配的职位'), /内联|relation|关系|ID/i);
});

test('readRelation fails closed when the relation property is missing', async () => {
  const ws = tempWorkspace();
  ws.writeState({ pages: { 'cand-1': page('cand-1', '甲') } });
  const { readRelation } = await load(ws);
  await assert.rejects(() => readRelation('cand-1', '匹配的职位'), /属性|property|relation/i);
});

test('updatePage rejects relation writes above the Notion array limit before sending PATCH', async () => {
  const ws = tempWorkspace();
  ws.writeState({ pages: { 'p-1': page('p-1', '页面', { properties: {} }) } });
  const { updatePage } = await load(ws);
  const relation = Array.from({ length: 101 }, (_, i) => ({ id: `id-${i}` }));
  await assert.rejects(() => updatePage('p-1', { '关系': { relation } }), /100|上限|limit|关系/i);
  assert.equal((ws.readState().writes || []).length, 0);
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

test('local lock does not steal a stale lock whose owner process is still alive', async () => {
  const ws = tempWorkspace();
  const { acquireLock } = await load(ws);
  const dir = path.join(ws.root, 'lock-live');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'link.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'live-owner', createdAt: new Date().toISOString() }), { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockFile, old, old);
  assert.throws(() => acquireLock(dir, 'link', { staleMs: 1 }), /锁|lock|占用|owner/i);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'live-owner');
});

test('local lock reclaims a stale lock only when its owner process is dead', async () => {
  const ws = tempWorkspace();
  const { acquireLock } = await load(ws);
  const dir = path.join(ws.root, 'lock-dead');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'link.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: 'dead-owner', createdAt: new Date().toISOString() }), { mode: 0o600 });
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockFile, old, old);
  const release = acquireLock(dir, 'link', { staleMs: 1 });
  assert.notEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'dead-owner');
  release();
});

test('local lock release never deletes a lock owned by another token', async () => {
  const ws = tempWorkspace();
  const { acquireLock } = await load(ws);
  const dir = path.join(ws.root, 'lock-release');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'link.lock');
  const release = acquireLock(dir, 'link');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'other-owner', createdAt: new Date().toISOString() }), { mode: 0o600 });
  release();
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'other-owner');
});
