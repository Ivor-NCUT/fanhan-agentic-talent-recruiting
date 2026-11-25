import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'fanhan-ntn.mjs');

const FAKE_NTN = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const file = process.env.FAKE_NTN_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
state.calls ??= [];
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); save(); };
const fail = (code, message) => { process.stderr.write(message); save(); process.exit(code); };
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
state.calls.push(args);
if (args[0] === 'whoami') { save(); process.stdout.write('user\tx\tx\tx\tx\tfixture-workspace\n'); process.exit(0); }
if (args[0] === '--version') { save(); process.stdout.write('fake-ntn 0.0.0\n'); process.exit(0); }
if (args[0] === 'datasources' && args[1] === 'query') {
  const ds = args[2];
  const dataset = state.datasets?.[ds];
  if (!dataset) fail(1, 'unknown data source ' + ds);
  const cursor = flag('--start-cursor');
  const index = cursor == null ? 0 : Number(cursor);
  const failAt = dataset.failAt?.[index];
  if (failAt && !(dataset.failOnce && state.counters?.[ds + ':fail:' + index])) {
    state.counters ??= {};
    if (dataset.failOnce) state.counters[ds + ':fail:' + index] = true;
    fail(failAt.status || 1, failAt.message || 'fixture failure');
  }
  const rateAt = dataset.rateLimitAt?.[index];
  if (rateAt) {
    state.counters ??= {};
    const key = ds + ':rate:' + index;
    const count = state.counters[key] || 0;
    state.counters[key] = count + 1;
    if (count < (dataset.rateLimitTimes || 1)) fail(rateAt.status || 429, rateAt.message || 'rate limited');
  }
  const pages = dataset.pages || [];
  const results = pages[index] || [];
  const has_more = index + 1 < pages.length;
  out({ object: 'list', results, has_more, next_cursor: has_more ? String(index + 1) : null, request_status: dataset.requestStatus?.[index] || undefined });
  process.exit(0);
}
if (args[0] === 'api') {
  let p = args[1];
  const q = p.indexOf('?');
  const query = new URLSearchParams(q >= 0 ? p.slice(q + 1) : '');
  if (q >= 0) p = p.slice(0, q);
  const method = flag('-X', 'GET');
  const pageMatch = p.match(/^\/v1\/pages\/([^/]+)$/);
  const propMatch = p.match(/^\/v1\/pages\/([^/]+)\/properties\/([^/]+)$/);
  if (method === 'PATCH' && pageMatch) {
    if (state.writeDelayMs) await new Promise((resolve) => setTimeout(resolve, state.writeDelayMs));
    const id = pageMatch[1];
    const page = state.pages?.[id];
    if (!page) fail(1, 'page not found ' + id);
    if (state.failWriteIds?.includes(id)) fail(1, 'fixture write failure ' + id);
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch {}
    const body = raw ? JSON.parse(raw) : {};
    state.writes ??= [];
    state.writes.push({ id, body });
    for (const [name, value] of Object.entries(body.properties || {})) {
      page.properties[name] ??= { id: name, type: Object.keys(value)[0] };
      if (value.relation) {
        page.properties[name].relation = value.relation;
        page.properties[name].has_more = false;
        state.relations ??= {};
        state.relations[id] ??= {};
        state.relations[id][name] = { ids: value.relation.map((r) => r.id) };
      }
      if (value.rich_text) page.properties[name].rich_text = value.rich_text;
      if (value.checkbox !== undefined) page.properties[name].checkbox = value.checkbox;
    }
    out(page);
    process.exit(0);
  }
  if (method === 'GET' && pageMatch) {
    const id = pageMatch[1];
    const page = state.pages?.[id];
    if (!page) fail(1, 'page not found ' + id);
    if (state.failPageIds?.includes(id)) fail(1, 'fixture page failure ' + id);
    out(structuredClone(page));
    process.exit(0);
  }
  if (method === 'GET' && propMatch) {
    const [, id, prop] = propMatch;
    const page = state.pages?.[id];
    if (!page) fail(1, 'page not found ' + id);
    const name = page.properties?.[prop] ? prop : Object.keys(page.properties || {}).find((k) => page.properties[k].id === prop);
    const rel = state.relations?.[id]?.[name || prop];
    if (!rel) fail(1, 'relation fixture missing ' + id + ' ' + prop);
    const size = Number(query.get('page_size') || 100);
    const start = Number(query.get('start_cursor') || 0);
    const slice = rel.ids.slice(start, start + size);
    const next = start + size < rel.ids.length ? String(start + size) : null;
    const results = slice.map((rid) => rel.malformed
      ? { object: 'property_item', type: 'relation', id: 'property-item-outer' }
      : { object: 'property_item', type: 'relation', id: 'property-item-outer', relation: { id: rid } });
    out({ object: 'list', type: 'property_item', results, has_more: !!next, next_cursor: next });
    process.exit(0);
  }
  fail(1, 'unsupported api call ' + args.join(' '));
}
fail(1, 'unsupported fake ntn call ' + args.join(' '));
`;

export function tempWorkspace(prefix = 'fanhan-ntn-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'ntn');
  fs.mkdirSync(path.join(home, '.fanhan-ntn'), { recursive: true });
  fs.writeFileSync(bin, FAKE_NTN, { mode: 0o755 });
  const stateFile = path.join(root, 'state.json');
  const env = {
    ...process.env,
    HOME: home,
    FANHAN_NTN_BIN: bin,
    FAKE_NTN_STATE: stateFile,
    NO_COLOR: '1',
    FANHAN_DS_CANDIDATES: 'ds-candidates',
    FANHAN_DS_JOBS: 'ds-jobs',
    FANHAN_DS_COMPANIES: 'ds-companies',
  };
  const writeState = (state) => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: path.resolve(path.dirname(CLI), '..'),
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  const runAsync = (args, extraEnv = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: path.resolve(path.dirname(CLI), '..'),
      env: { ...env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const runScript = (script, args = [], extraEnv = {}) => spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve(path.dirname(CLI), '..'),
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  const writeCache = (name, data) => {
    const dir = path.join(home, '.fanhan-ntn');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
  };
  const readCache = (name) => JSON.parse(fs.readFileSync(path.join(home, '.fanhan-ntn', name), 'utf8'));
  return { root, home, bin, stateFile, env, writeState, readState, run, runAsync, runScript, writeCache, readCache };
}

export function page(id, name, props = {}) {
  return {
    object: 'page',
    id,
    last_edited_time: '2025-01-01T00:00:00.000Z',
    properties: {
      '候选人昵称': props.titleProperty || { id: 'title', type: 'title', title: [{ plain_text: name }] },
      ...props.properties,
    },
  };
}

export function relation(ids, { hasMore = false, id = 'rel' } = {}) {
  return { id, type: 'relation', relation: ids.map((id) => ({ id })), has_more: hasMore };
}

export function rich(text) {
  return { id: 'rt', type: 'rich_text', rich_text: [{ plain_text: text }] };
}

export function select(name, type = 'select') {
  return { id: 'sel', type, [type]: name ? { name } : null };
}
