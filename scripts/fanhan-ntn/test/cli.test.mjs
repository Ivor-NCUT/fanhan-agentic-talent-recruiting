import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempWorkspace, page, relation, rich, select } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILL = path.resolve(HERE, '..', 'scripts', 'fill_job_json.mjs');
const title = (text) => ({ id: `title-${text}`, type: 'title', title: [{ plain_text: text }] });

function candidatePage(id, name, {
  matchedJobs = [], companies = [], duplicate = false, seeking = 'OPEN', note = '', emailBody = '',
  json = { skills: [{ value: 'Python 服务端' }] }, includeSafety = true, extraProps = {},
  includeRecommended = true,
} = {}) {
  const p = {
    '候选人昵称': title(name),
    '候选人检索 JSON': rich(JSON.stringify(json)),
    '候选人职位类目': select('算法'),
    '匹配的职位': relation(matchedJobs),
    ...(includeRecommended ? { '推荐过的公司': relation(companies) } : {}),
    '备注': rich(note),
    '邮件正文': rich(emailBody),
  };
  if (includeSafety) {
    p['是否重复'] = { id: 'dup', type: 'checkbox', checkbox: duplicate };
    p['求职状态'] = select(seeking);
    p['全局不推荐'] = { id: 'dnr', type: 'checkbox', checkbox: false };
    p['撤回状态'] = { id: 'wd', type: 'checkbox', checkbox: false };
  }
  Object.assign(p, extraProps);
  return page(id, name, { properties: p });
}

function jobPage(id, name, {
  companyIds = [], status = '招聘中', statusType = 'status', matched = [], description = '负责 Python 服务端研发。',
  json = undefined, includeStatus = true, includeJson = true,
} = {}) {
  const p = {
    '职位名称': title(name),
    '职位描述': rich(description),
    '职位类目': select('算法'),
    '关联公司': relation(companyIds),
    '匹配的人选': relation(matched),
  };
  if (includeStatus) p['岗位状态'] = select(status, statusType);
  if (includeJson) p['职位检索 JSON'] = rich(json === undefined ? '' : JSON.stringify(json));
  return page(id, name, { properties: p });
}

function companyPage(id, name) {
  return page(id, name, {
    titleProperty: { id: 'title', type: 'title', title: [{ plain_text: name }] },
    properties: {},
  });
}

function stateWith({ candidates = [], jobs = [], companies = [], fail = {}, requestStatus = {}, relations = {}, pages = {} }) {
  return {
    datasets: {
      'ds-candidates': { pages: [candidates], ...fail.candidates, requestStatus: requestStatus.candidates },
      'ds-jobs': { pages: [jobs], ...fail.jobs, requestStatus: requestStatus.jobs },
      'ds-companies': { pages: [companies], ...fail.companies, requestStatus: requestStatus.companies },
    },
    pages: Object.fromEntries([...candidates, ...jobs, ...companies].map((p) => [p.id, p])),
    relations,
  };
}

function configureSafety(ws, safety = {}) {
  fs.writeFileSync(path.join(ws.home, '.fanhan-ntn', 'config.json'), JSON.stringify({
    safety: {
      doNotRecommend: '全局不推荐',
      withdrawn: '撤回状态',
      ...safety,
    },
  }));
}

function startServer(handler, tls = null) {
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const protocol = tls ? 'https' : 'http';
    resolve({ server, url: `${protocol}://127.0.0.1:${server.address().port}` });
  }));
}

function goodAnswer(score = 3.5) {
  return JSON.stringify({
    answers: {
      fit: { score, confidence: 0.9, probabilities: { 2: 0.2, 3: 0.3, 4: 0.5 } },
      must_have: { noul: 0.9 },
      employment_conflict: { noul: 0.01 },
      seniority_ok: { noul: 0.9 },
    },
  });
}

test('sync leaves the complete old cache untouched on a partial failure', () => {
  const ws = tempWorkspace();
  ws.writeCache('candidates.json', { syncedAt: 'old', records: [{ id: 'old-c' }] });
  ws.writeCache('jobs.json', { syncedAt: 'old', records: [{ id: 'old-j' }] });
  ws.writeCache('companies.json', { syncedAt: 'old', records: [{ id: 'old-co' }] });
  ws.writeCache('meta.json', { syncedAt: 'old' });
  ws.writeState(stateWith({
    candidates: [candidatePage('c1', '甲')],
    jobs: [],
    companies: [],
    fail: { jobs: { failAt: { 0: { status: 1, message: 'jobs boom' } } } },
  }));
  const r = ws.run(['sync']);
  assert.notEqual(r.status, 0);
  assert.deepEqual(ws.readCache('candidates.json').records.map((x) => x.id), ['old-c']);
  assert.deepEqual(ws.readCache('jobs.json').records.map((x) => x.id), ['old-j']);
  assert.deepEqual(ws.readCache('meta.json'), { syncedAt: 'old' });
});

test('sync rejects request_status incomplete and keeps the old cache', () => {
  const ws = tempWorkspace();
  ws.writeCache('candidates.json', { syncedAt: 'old', records: [{ id: 'old-c' }] });
  ws.writeCache('jobs.json', { syncedAt: 'old', records: [] });
  ws.writeCache('companies.json', { syncedAt: 'old', records: [] });
  ws.writeState(stateWith({
    candidates: [candidatePage('c1', '甲')],
    requestStatus: { candidates: [{ type: 'incomplete', incomplete_reason: 'timeout' }] },
  }));
  const r = ws.run(['sync']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /incomplete|不完整|timeout/i);
  assert.deepEqual(ws.readCache('candidates.json').records.map((x) => x.id), ['old-c']);
});

test('sync follows all pages, publishes complete snapshot and tightens permissions', () => {
  const ws = tempWorkspace();
  const dir = path.join(ws.home, '.fanhan-ntn');
  fs.chmodSync(dir, 0o755);
  ws.writeCache('candidates.json', { syncedAt: 'old', records: [] });
  fs.chmodSync(path.join(dir, 'candidates.json'), 0o644);
  const many = Array.from({ length: 26 }, (_, i) => candidatePage(`c-${i}`, `候选${i}`));
  const state = stateWith({ candidates: many.slice(0, 10) });
  state.datasets['ds-candidates'].pages = [many.slice(0, 10), many.slice(10, 20), many.slice(20)];
  ws.writeState(state);
  const r = ws.run(['sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ws.readCache('candidates.json').records.length, 26);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const file of ['candidates.json', 'jobs.json', 'companies.json', 'meta.json']) {
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  }
});

test('match --json --no-llm writes JSON only to stdout and keeps same-title jobs distinct', () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲')],
    jobs: [jobPage('job-1', '算法工程师', { companyIds: ['co-1'] }), jobPage('job-2', '算法工程师', { companyIds: ['co-2'] })],
    companies: [companyPage('co-1', '公司一'), companyPage('co-2', '公司二')],
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['match', '--candidate', '甲', '--no-llm', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.deepEqual(data.results.map((x) => x.id).sort(), ['job-1', 'job-2']);
  assert.equal(data.results.length, 2);
});

test('model partial failure is explicit, nonzero, and failed records survive top/min filters', async () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-a', '甲'), candidatePage('cand-b', '乙')],
    jobs: [jobPage('job-1', '算法工程师')],
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const keyPath = path.join(ws.root, 'test-key.pem');
  const certPath = path.join(ws.root, 'test-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  const { server, url } = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (body.includes('甲')) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('synthetic failure');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(goodAnswer(4));
      }
    });
  }, { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) });
  try {
    const r = await ws.runAsync(['match', '--job', 'job-1', '--top', '1', '--min', '90', '--json'], {
      FANHAN_DECIDER_PROVIDER: 'custom',
      FANHAN_LLM_API_KEY: 'sk-synthetic',
      FANHAN_DECIDER_BASE: url,
      FANHAN_LLM_RETRY_DELAY_MS: '0',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    assert.notEqual(r.status, 0, 'partial model failure must be nonzero');
    const data = JSON.parse(r.stdout);
    assert.equal(data.failures.length, 1);
    assert.match(data.failures[0].name, /甲/);
    assert.equal(data.partial, true);
    assert.ok(data.results.length <= 1);
  } finally {
    server.close();
  }
});

test('link dry-run writes nothing; sequential --yes runs merge fresh relations instead of stale cache', () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲', { matchedJobs: ['job-old'] })],
    jobs: [jobPage('job-1', '岗位一'), jobPage('job-2', '岗位二')],
    relations: {
      'cand-1': { '匹配的职位': { ids: ['job-old'] } },
      'job-1': { '匹配的人选': { ids: [] } },
      'job-2': { '匹配的人选': { ids: [] } },
    },
  }));
  configureSafety(ws);
  assert.equal(ws.run(['sync']).status, 0);
  const dry = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal((ws.readState().writes || []).length, 0);
  assert.equal(ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']).status, 0);
  const second = ws.run(['link', '--candidate', '甲', '--jobs', '岗位二', '--yes']);
  assert.equal(second.status, 0, second.stderr);
  const state = ws.readState();
  const ids = state.pages['cand-1'].properties['匹配的职位'].relation.map((r) => r.id);
  assert.deepEqual(ids.sort(), ['job-1', 'job-2', 'job-old']);
});

test('link fails closed when safety schema is absent and writes nothing', () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲', { includeSafety: false })],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /安全|安全字段|safety|重复|求职状态|撤回/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('link fails closed when fresh job status is missing', () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲')],
    jobs: [jobPage('job-1', '岗位一', { includeStatus: false })],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  configureSafety(ws);
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /状态|招聘中|status/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('concurrent link is serialized by the local lock and does not lose earlier additions', async () => {
  const ws = tempWorkspace();
  const state = stateWith({
    candidates: [candidatePage('cand-1', '甲', { matchedJobs: ['job-old'] })],
    jobs: [jobPage('job-1', '岗位一'), jobPage('job-2', '岗位二')],
    relations: {
      'cand-1': { '匹配的职位': { ids: ['job-old'] } },
      'job-1': { '匹配的人选': { ids: [] } },
      'job-2': { '匹配的人选': { ids: [] } },
    },
  });
  state.writeDelayMs = 250;
  ws.writeState(state);
  configureSafety(ws);
  assert.equal(ws.run(['sync']).status, 0);
  const [a, b] = await Promise.all([
    ws.runAsync(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']),
    ws.runAsync(['link', '--candidate', '甲', '--jobs', '岗位二', '--yes']),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses.includes(0), 'at least one concurrent link succeeds');
  assert.ok(statuses.some((s) => s !== 0), 'lock rejects the overlapping writer');
  const first = ws.readState();
  const ids = first.pages['cand-1'].properties['匹配的职位'].relation.map((r) => r.id);
  assert.ok(ids.includes('job-old'));
  assert.ok(ids.includes('job-1') || ids.includes('job-2'));
  const retry = ws.run(['link', '--candidate', '甲', '--jobs', ids.includes('job-1') ? '岗位二' : '岗位一', '--yes']);
  assert.equal(retry.status, 0, retry.stderr);
  const after = ws.readState().pages['cand-1'].properties['匹配的职位'].relation.map((r) => r.id).sort();
  assert.deepEqual(after, ['job-1', 'job-2', 'job-old']);
});

test('match rejects removed --batch and invalid concurrency before touching cache', () => {
  const ws = tempWorkspace();
  const batch = ws.run(['match', '--candidate', '甲', '--batch', '8', '--no-llm', '--json']);
  assert.notEqual(batch.status, 0);
  assert.match(batch.stderr, /batch|并发|concurrency/i);
  const conc = ws.run(['match', '--candidate', '甲', '--concurrency', '0', '--no-llm', '--json']);
  assert.notEqual(conc.status, 0);
  assert.match(conc.stderr, /concurrency|并发|正整数/i);
});

test('link write failure exits nonzero and does not report false success', () => {
  const ws = tempWorkspace();
  const state = stateWith({
    candidates: [candidatePage('cand-1', '甲')],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  });
  state.failWriteIds = ['job-1'];
  ws.writeState(state);
  configureSafety(ws);
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /失败|写入|校验|write|fixture/i);
  assert.doesNotMatch(r.stdout, /岗位「岗位一」.*已写入并复核/);
});

test('link honours an explicitly configured withdrawn safety field', () => {
  const ws = tempWorkspace();
  configureSafety(ws);
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲', { extraProps: { '撤回状态': select('已撤回') } })],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /撤回|安全|safety/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('link --yes fails closed when global safety protections are not configured', () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲')],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /全局|不推荐|撤回|safety|配置/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('link honours mapped duplicate/seeking fields and validates their values', () => {
  const ws = tempWorkspace();
  configureSafety(ws, { duplicate: '重复标记', seeking: '求职意向状态' });
  const cand = candidatePage('cand-1', '甲', {
    includeSafety: false,
    extraProps: {
      '重复标记': select('不重复'),
      '求职意向状态': select('求职中'),
      '全局不推荐': select('可推荐'),
      '撤回状态': select('未撤回'),
    },
  });
  ws.writeState(stateWith({
    candidates: [cand],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((ws.readState().writes || []).length, 2);
});

test('link rejects unsupported safety field types before any PATCH', () => {
  const ws = tempWorkspace();
  configureSafety(ws, { duplicate: '重复标记' });
  const cand = candidatePage('cand-1', '甲', {
    includeSafety: false,
    extraProps: {
      '重复标记': { id: 'dup-formula', type: 'formula', formula: { boolean: false } },
      '求职状态': select('OPEN'),
      '全局不推荐': { id: 'dnr', type: 'checkbox', checkbox: false },
      '撤回状态': { id: 'wd', type: 'checkbox', checkbox: false },
    },
  });
  ws.writeState(stateWith({
    candidates: [cand],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /类型|formula|不支持|安全/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('link --yes rejects empty or unknown seeking instead of treating it as safe', () => {
  const ws = tempWorkspace();
  configureSafety(ws);
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲', { seeking: '未知' })],
    jobs: [jobPage('job-1', '岗位一')],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /求职|状态|未知|安全/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('link --mark-recommended validates all safety and relation prerequisites before any PATCH', () => {
  const ws = tempWorkspace();
  configureSafety(ws);
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲', { includeRecommended: false })],
    jobs: [jobPage('job-1', '岗位一', { companyIds: ['co-1'] })],
    relations: { 'cand-1': { '匹配的职位': { ids: [] } }, 'job-1': { '匹配的人选': { ids: [] } } },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--mark-recommended', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /推荐|公司|relation|属性|缺少|安全/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('link fails closed before any PATCH when a relation would exceed the Notion write limit', () => {
  const ws = tempWorkspace();
  configureSafety(ws);
  const existing = Array.from({ length: 100 }, (_, i) => `other-${i}`);
  ws.writeState(stateWith({
    candidates: [candidatePage('cand-1', '甲')],
    jobs: [jobPage('job-1', '岗位一', { matched: existing })],
    relations: {
      'cand-1': { '匹配的职位': { ids: [] } },
      'job-1': { '匹配的人选': { ids: existing } },
    },
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['link', '--candidate', '甲', '--jobs', '岗位一', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /100|上限|limit|关系/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('get --job shows the full current description and flags stale retrieval JSON', () => {
  const ws = tempWorkspace();
  const current = '当前 Notion 职位描述：负责核心交易系统的架构设计与稳定性建设，需要长期投入并承担线上值班。';
  ws.writeState(stateWith({
    candidates: [],
    jobs: [jobPage('job-1', '后端工程师', { description: current, json: { description: '旧的检索 JSON 描述' } })],
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.run(['get', '--job', 'job-1']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(current), 'full current description should be printed without truncation');
  assert.match(r.stdout, /历史检索 JSON|不同|不覆盖/i);
});

test('cache age and staleness are visible in status, list and get', () => {
  const ws = tempWorkspace();
  const cand = {
    kind: 'candidate', id: 'c1', name: '甲', category: '算法', categoryKey: 'data_ai',
    empType: { value: 'full_time', basis: 'fixture' }, hasJson: true, searchJson: {}, items: [],
    note: '', emailBody: '', rolesText: '', citiesText: '', cities: [], relations: { matchedJobs: [], appliedJobs: [], companies: [] },
  };
  ws.writeCache('candidates.json', { syncedAt: '2020-01-01T00:00:00.000Z', records: [cand] });
  ws.writeCache('jobs.json', { syncedAt: '2020-01-01T00:00:00.000Z', records: [] });
  ws.writeCache('companies.json', { syncedAt: '2020-01-01T00:00:00.000Z', records: [] });
  ws.writeCache('meta.json', { syncedAt: '2020-01-01T00:00:00.000Z', counts: { candidates: 1, jobs: 0, companies: 0 } });
  for (const args of [['status'], ['list', 'candidates'], ['get', 'candidate', '甲']]) {
    const r = ws.run(args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /过期|stale|同步于/i, args.join(' '));
  }
});

test('fill_job_json defaults to dry-run, requires --yes, verifies fresh state and exits nonzero on conflict', () => {
  const ws = tempWorkspace();
  ws.writeState(stateWith({
    jobs: [jobPage('job-1', '后端工程师', { description: '负责 Python 服务端研发、接口设计与高并发系统优化。' })],
  }));
  assert.equal(ws.run(['sync']).status, 0);
  const dry = ws.runScript(FILL);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal((ws.readState().writes || []).length, 0);

  const write = ws.runScript(FILL, ['--yes']);
  assert.equal(write.status, 0, write.stderr);
  assert.equal(ws.readState().writes.length, 1);
  assert.ok(ws.readState().writes[0].body.properties['职位检索 JSON'].rich_text.length > 0);

  const conflict = ws.runScript(FILL, ['--yes']);
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr + conflict.stdout, /冲突|已存在|conflict|fresh|当前/i);
  assert.equal(ws.readState().writes.length, 1);
});

test('fill_job_json refuses a cleared fresh description instead of resurrecting the cache', () => {
  const ws = tempWorkspace();
  const state = stateWith({
    jobs: [jobPage('job-1', '后端工程师', { description: '负责 Python 服务端研发、接口设计与高并发系统优化。' })],
  });
  ws.writeState(state);
  assert.equal(ws.run(['sync']).status, 0);
  delete state.pages['job-1'].properties['职位描述'];
  ws.writeState(state);
  const r = ws.runScript(FILL, ['--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /描述|description|缺失|schema|冲突/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('fill_job_json refuses missing or non-rich-text target JSON properties', () => {
  const ws = tempWorkspace();
  const state = stateWith({
    jobs: [jobPage('job-1', '后端工程师', { description: '负责 Python 服务端研发、接口设计与高并发系统优化。', includeJson: false })],
  });
  ws.writeState(state);
  assert.equal(ws.run(['sync']).status, 0);
  const missing = ws.runScript(FILL, ['--yes']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr + missing.stdout, /JSON|属性|schema|类型|缺失/i);
  assert.equal((ws.readState().writes || []).length, 0);

  state.pages['job-1'].properties['职位检索 JSON'] = select('错误类型');
  ws.writeState(state);
  const wrong = ws.runScript(FILL, ['--yes']);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr + wrong.stdout, /JSON|rich_text|属性|schema|类型/i);
  assert.equal((ws.readState().writes || []).length, 0);
});

test('fill_job_json fails when post-write content differs from the intended payload', () => {
  const ws = tempWorkspace();
  const state = stateWith({
    jobs: [jobPage('job-1', '后端工程师', { description: '负责 Python 服务端研发、接口设计与高并发系统优化。' })],
  });
  state.postWriteRichText = { 'job-1': { '职位检索 JSON': JSON.stringify({ tampered: true }) } };
  ws.writeState(state);
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.runScript(FILL, ['--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /复核|不一致|mismatch|hash|内容/i);
  assert.equal((ws.readState().writes || []).length, 1);
});

test('fill_job_json rechecks immediately before PATCH and aborts on an intervening change', () => {
  const ws = tempWorkspace();
  const state = stateWith({
    jobs: [jobPage('job-1', '后端工程师', { description: '负责 Python 服务端研发、接口设计与高并发系统优化。' })],
  });
  state.mutatePageOnGet = { 'job-1': { at: 2, removeProperty: '职位描述' } };
  ws.writeState(state);
  assert.equal(ws.run(['sync']).status, 0);
  const r = ws.runScript(FILL, ['--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /描述|冲突|预检|并发/i);
  assert.equal((ws.readState().writes || []).length, 0);
});
