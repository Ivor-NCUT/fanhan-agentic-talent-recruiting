import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCandidate,
  normalizeJob,
  employmentFromText,
  categoryKey,
  categoryFromKey,
  extractCities,
  EMP_LABEL,
} from '../src/parse.mjs';
import { page, relation, rich, select } from './helpers.mjs';

const jsonProp = (value) => rich(JSON.stringify(value));

test('employment: historical years are not full-time evidence', () => {
  assert.equal(employmentFromText('2019 年毕业，有 5 年工作经验', '正文').value, 'unknown');
});

test('employment: negated internship is not internship intent', () => {
  assert.equal(employmentFromText('不接受实习，只考虑正职', '备注').value, 'unknown');
  assert.equal(employmentFromText('求职意向：不接受实习', '备注').value, 'unknown');
});

test('employment: historical internship is not current intent', () => {
  assert.equal(employmentFromText('2024 实习经历：某公司算法实习生', '备注').value, 'unknown');
});

test('employment: explicit structured intent supports part_time and internship', () => {
  assert.equal(employmentFromText('求职意向：兼职', '备注').value, 'part_time');
  assert.equal(employmentFromText('招聘类型：实习', '正文').value, 'internship');
  assert.equal(employmentFromText('工作性质：全职', '正文').value, 'full_time');
});

test('employment: 可实习 title plus 全职 body is not forced to internship', () => {
  const job = normalizeJob(page('job-1', '算法工程师（可实习）', {
    titleProperty: { id: 'title', type: 'title', title: [{ plain_text: '算法工程师（可实习）' }] },
    properties: {
      '职位描述': rich('本岗位为全职岗位，接受应届生。'),
      '岗位状态': select('招聘中', 'status'),
    },
  }));
  assert.notEqual(job.empType.value, 'internship');
});

test('employment: structured Notion property wins and part_time is labelled', () => {
  const cand = normalizeCandidate(page('cand-1', '甲', {
    properties: {
      '雇佣类型': { id: 'emp', type: 'select', select: { name: '兼职' } },
      '候选人检索 JSON': jsonProp({ preferences: { employmentType: { value: '实习' } } }),
    },
  }));
  assert.equal(cand.empType.value, 'part_time');
  assert.equal(EMP_LABEL.part_time, '兼职');
});

test('employment: candidate structured JSON part_time is recognized', () => {
  const cand = normalizeCandidate(page('cand-2', '乙', {
    properties: {
      '候选人检索 JSON': jsonProp({ preferences: { employmentType: { value: 'part_time' } } }),
    },
  }));
  assert.equal(cand.empType.value, 'part_time');
});

test('cities: desired cities stay separate from current location', () => {
  const cand = normalizeCandidate(page('cand-3', '丙', {
    properties: {
      '候选人检索 JSON': jsonProp({
        preferences: { cities: { value: '上海、杭州' } },
        currentLocation: '北京',
      }),
    },
  }));
  assert.deepEqual(cand.cities, ['上海', '杭州']);
  assert.deepEqual(cand.currentCities, ['北京']);
});

test('categories: unknown is preserved instead of collapsed to other', () => {
  assert.equal(categoryKey(''), '');
  assert.equal(categoryKey('未知职类'), '');
  assert.equal(categoryKey('其它'), 'other');
  assert.equal(categoryFromKey('growth_marketing'), '增长/市场/运营');
});

test('categories: operations and growth/market labels reconcile', () => {
  for (const label of ['增长/运营/市场', '增长/市场/运营', '增长运营', '市场运营']) {
    assert.equal(categoryKey(label), 'growth_marketing', label);
  }
  assert.equal(categoryKey('运营'), 'operations');
  assert.equal(categoryKey('市场'), 'growth_marketing');
});

test('cities: extractCities stays a deterministic helper', () => {
  assert.deepEqual(extractCities('期望上海或杭州'), ['上海', '杭州']);
});

test('job description: current Notion text is not overwritten by stale retrieval JSON', () => {
  const job = normalizeJob(page('job-2', '后端工程师', {
    properties: {
      '职位描述': rich('当前 Notion 职位描述：负责服务端。'),
      '职位招聘偏好': rich('当前偏好：全职，上海。'),
      '职位检索 JSON': jsonProp({ description: '旧检索描述：实习，北京。', preferences: '旧偏好：兼职，深圳。' }),
      '岗位状态': select('招聘中', 'status'),
    },
  }));
  assert.match(job.description, /当前 Notion 职位描述/);
  assert.match(job.retrievedDescription, /旧检索描述/);
  assert.equal(job.descriptionDiff.changed, true);
  assert.match(job.preference, /当前偏好/);
  assert.match(job.retrievedPreference, /旧偏好/);
});

test('job status: select and status property types are both supported', () => {
  const job = normalizeJob(page('job-3', '产品经理', {
    properties: {
      '岗位状态': { id: 'st', type: 'status', status: { name: '招聘中' } },
      '职位描述': rich('负责产品。'),
    },
  }));
  assert.equal(job.status, '招聘中');
});

test('empty candidate JSON falls back to notes/email with an explanation', () => {
  const cand = normalizeCandidate(page('cand-4', '丁', {
    properties: {
      '候选人检索 JSON': rich('{}'),
      '备注': rich('备注里的候选人信息'),
      '邮件正文': rich('邮件正文里的候选人信息'),
    },
  }));
  assert.equal(cand.hasJson, false);
  assert.equal(cand.searchJson, null);
  assert.match(cand.text, /备注里的候选人信息/);
  assert.match(cand.text, /邮件正文里的候选人信息/);
  assert.match(cand.materialSource, /备注|邮件/);
  assert.ok(cand.fallbackReason);
});
