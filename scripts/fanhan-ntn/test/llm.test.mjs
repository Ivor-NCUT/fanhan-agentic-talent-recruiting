import test from 'node:test';
import assert from 'node:assert/strict';
import { llmConfig, judge, judgeSingle } from '../src/llm.mjs';

const rec = (id) => ({ id, name: id, category: '算法', searchJson: { skills: [] }, text: 'Python' });
const subject = { id: 'job', name: '岗位', category: '算法', description: 'Python', searchJson: null, text: 'Python' };

const okResponse = (score = 2.6) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({
    answers: {
      fit: { score, confidence: 0.8, probabilities: { 1: 0.1, 2: 0.45, 3: 0.35, 4: 0.1 } },
      must_have: { noul: 0.7 },
      employment_conflict: { noul: 0.05 },
      seniority_ok: { noul: 0.8 },
    },
    usage: { input_tokens: 10 },
  }),
});

test('llm config never silently uses a DeepSeek key against the Perplexity endpoint', () => {
  const cfg = llmConfig({ FANHAN_DECIDER_BASE: 'https://api.perplexity.ai', DEEPSEEK_API_KEY: 'sk-deep' });
  assert.equal(cfg.configured, false);
  assert.equal(cfg.keySource, 'none');
});

test('llm config binds provider, endpoint and key explicitly', () => {
  const deep = llmConfig({
    FANHAN_DECIDER_PROVIDER: 'deepseek',
    FANHAN_DECIDER_BASE: 'https://api.deepseek.com',
    DEEPSEEK_API_KEY: 'sk-deep',
  });
  assert.equal(deep.configured, true);
  assert.equal(deep.provider, 'deepseek');
  assert.equal(deep.base, 'https://api.deepseek.com');

  const mismatch = llmConfig({
    FANHAN_DECIDER_PROVIDER: 'deepseek',
    FANHAN_DECIDER_BASE: 'https://api.deepseek.com',
    PERPLEXITY_API_KEY: 'sk-perp',
  });
  assert.equal(mismatch.configured, false);

  const perp = llmConfig({ FANHAN_DECIDER_PROVIDER: 'perplexity', PERPLEXITY_API_KEY: 'sk-perp' });
  assert.equal(perp.configured, true);
  assert.equal(perp.base, 'https://api.perplexity.ai');
});

test('judge uses injected fetch and keeps fit.score * 25 while naming the label basis', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return okResponse(2.6);
  };
  const res = await judge('job2cand', subject, [rec('a')], {
    env: { FANHAN_DECIDER_PROVIDER: 'perplexity', PERPLEXITY_API_KEY: 'sk-synthetic' },
    fetchImpl,
  });
  assert.equal(seen.url, 'https://api.perplexity.ai/v1/decisions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-synthetic');
  assert.equal(res.results[0].llm.score, 65);
  assert.equal(res.results[0].llm.levelBasis, 'expected-score-rounded');
  assert.equal(res.results[0].llm.level, '比较合适');
  assert.equal(res.results[0].llm.modalLevel, '可以一试');
  assert.equal(res.summary.failed, 0);
});

test('judge reports total model failure instead of silently returning empty scores', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  const res = await judge('job2cand', subject, [rec('a'), rec('b')], {
    env: { FANHAN_DECIDER_PROVIDER: 'perplexity', PERPLEXITY_API_KEY: 'sk-synthetic' },
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(res.summary.failed, 2);
  assert.equal(res.summary.partial, false);
  assert.ok(res.results.every((r) => r.llm.error));
});

test('judge makes partial failure explicit and keeps failed records', async () => {
  const fetchImpl = async (url, init) => (String(init.body).includes('"a"')
    ? { ok: false, status: 500, text: async () => 'boom' }
    : okResponse(3));
  const res = await judge('job2cand', subject, [rec('a'), rec('b')], {
    env: { FANHAN_DECIDER_PROVIDER: 'perplexity', PERPLEXITY_API_KEY: 'sk-synthetic' },
    fetchImpl,
    retryDelayMs: 0,
  });
  assert.equal(res.summary.failed, 1);
  assert.equal(res.summary.partial, true);
  assert.equal(res.results.length, 2);
  assert.ok(res.results.some((r) => r.llm.error));
});

test('judge rejects non-positive or non-integer concurrency', async () => {
  const opts = {
    env: { FANHAN_DECIDER_PROVIDER: 'perplexity', PERPLEXITY_API_KEY: 'sk-synthetic' },
    fetchImpl: async () => okResponse(),
  };
  await assert.rejects(() => judge('job2cand', subject, [rec('a')], { ...opts, concurrency: 0 }), /concurrency|并发/i);
  await assert.rejects(() => judge('job2cand', subject, [rec('a')], { ...opts, concurrency: 1.5 }), /concurrency|并发/i);
});

test('judgeSingle uses the same bound configuration', async () => {
  const res = await judgeSingle('job2cand', subject, rec('a'), {
    env: { FANHAN_DECIDER_PROVIDER: 'perplexity', PERPLEXITY_API_KEY: 'sk-synthetic' },
    fetchImpl: async () => okResponse(1),
  });
  assert.equal(res.score, 25);
});
