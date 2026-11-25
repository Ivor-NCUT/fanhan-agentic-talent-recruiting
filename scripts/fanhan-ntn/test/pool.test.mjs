import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, categoryRelation } from '../src/pool.mjs';

const job = (id, extra = {}) => ({
  kind: 'job',
  id,
  name: id,
  status: '招聘中',
  empType: { value: 'full_time', basis: 'fixture' },
  categoryKey: 'engineering',
  companyIds: [],
  relations: { matchedCandidates: [] },
  text: 'Python 服务端',
  ...extra,
});
const cand = (id, extra = {}) => ({
  kind: 'candidate',
  id,
  name: id,
  empType: { value: 'full_time', basis: 'fixture' },
  categoryKey: 'engineering',
  duplicate: false,
  seekingStatus: 'OPEN',
  relations: { companies: [] },
  text: 'Python 服务端',
  ...extra,
});

test('pool excludes missing job status instead of treating it as active', () => {
  const subject = job('subject');
  const records = [cand('a'), cand('b')];
  const excluded = buildPool('job2cand', subject, records);
  assert.equal(excluded.stats.unknownStatus, 0);
  assert.deepEqual(excluded.pool.map((r) => r.id), ['a', 'b']);

  const missing = job('closed-unknown', { status: null });
  const res = buildPool('job2cand', missing, records);
  assert.equal(res.pool.length, 0);
  assert.equal(res.stats.unknownStatus, 2);
  const relaxed = buildPool('job2cand', missing, records, { includeUnknownStatus: true });
  assert.equal(relaxed.pool.length, 2);
});

test('pool exposes duplicate, not-seeking and already-recommended exclusions', () => {
  const subject = job('subject', { companyIds: ['company-1'] });
  const records = [
    cand('ok'),
    cand('dup', { duplicate: true }),
    cand('away', { seekingStatus: 'NOT_LOOKING' }),
    cand('paused', { seekingStatus: '暂停求职' }),
    cand('explicit', { seekingStatus: '不求职' }),
    cand('already', { relations: { companies: ['company-1'] } }),
  ];
  const res = buildPool('job2cand', subject, records);
  assert.deepEqual(res.pool.map((r) => r.id), ['ok']);
  assert.equal(res.stats.duplicate, 1);
  assert.equal(res.stats.notSeeking, 3);
  assert.equal(res.stats.recommended, 1);
  assert.match(res.stats.details.join(' '), /重复|求职|推荐/);
  const relaxed = buildPool('job2cand', subject, records, {
    includeDuplicates: true,
    includeNotSeeking: true,
    includeRecommended: true,
  });
  assert.equal(relaxed.pool.length, 6);
});

test('pool does not hard-exclude unknown categories', () => {
  assert.equal(categoryRelation('', 'engineering'), 'unknown');
  const subject = job('subject', { categoryKey: '' });
  const res = buildPool('job2cand', subject, [cand('a'), cand('b', { categoryKey: '' })]);
  assert.equal(res.pool.length, 2);
});

test('pool reconciles operations and growth/marketing instead of excluding them', () => {
  assert.notEqual(categoryRelation('operations', 'growth_marketing'), 'distant');
  const subject = job('subject', { categoryKey: 'growth_marketing' });
  const res = buildPool('job2cand', subject, [cand('ops', { categoryKey: 'operations' })]);
  assert.deepEqual(res.pool.map((r) => r.id), ['ops']);
});

test('BM25 recall does not multiply repeated query terms over rare skills', () => {
  const subject = job('subject', { text: '增长 增长 增长 增长 Python' });
  const records = [
    cand('common', { text: '增长 增长 增长' }),
    cand('common-2', { text: '增长 运营' }),
    cand('rare', { text: 'Python 服务端' }),
    cand('filler', { text: '服务端 通用 描述' }),
  ];
  const res = buildPool('job2cand', subject, records, { maxRecords: 1 });
  assert.deepEqual(res.pool.map((r) => r.id), ['rare']);
});
