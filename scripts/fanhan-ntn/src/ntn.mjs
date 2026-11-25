import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 工作区相关的 data source ID 只存在本地配置或环境变量里，不进仓库 */
function localConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.fanhan-ntn', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const CFG = localConfig();
const pick = (key, envName) => process.env[envName] || CFG[key] || null;

export const DS = {
  candidates: pick('candidates', 'FANHAN_DS_CANDIDATES'),
  jobs: pick('jobs', 'FANHAN_DS_JOBS'),
  companies: pick('companies', 'FANHAN_DS_COMPANIES'),
};

export function assertConfigured() {
  const missing = Object.entries(DS).filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) return;
  throw new Error(
    `缺少 data source 配置：${missing.join(', ')}。请在 ~/.fanhan-ntn/config.json 写入 {"candidates":"...","jobs":"...","companies":"..."}，或设置 FANHAN_DS_CANDIDATES / FANHAN_DS_JOBS / FANHAN_DS_COMPANIES。用 ntn datasources resolve <database_id> 可查。`,
  );
}

export const DS_NAME = {
  candidates: '候选人库',
  jobs: '职位 JD 库',
  companies: '公司库',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnOnce(args, input) {
  return new Promise((resolve, reject) => {
    const bin = process.env.FANHAN_NTN_BIN || 'ntn';
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        reject(
          new Error(
            '找不到 ntn 命令。请先安装 Notion 官方 CLI 并执行 ntn login：https://www.npmjs.com/package/@notionhq/cli',
          ),
        );
      } else reject(e);
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code !== 0) {
        const e = new Error(`ntn ${args.slice(0, 3).join(' ')} 失败（exit ${code}）：${stderr.trim() || stdout.trim()}`);
        e.exitCode = code;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      resolve({ stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function run(args, input, { retries = 0, retryDelayMs } = {}) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await spawnOnce(args, input);
    } catch (e) {
      last = e;
      const detail = `${e.stderr || ''} ${e.stdout || ''} ${e.message || ''}`;
      const transient = e.exitCode === 429
        || (e.exitCode >= 500 && e.exitCode <= 599)
        || /(^|\D)429(\D|$)|rate.?limit|too many requests|(^|\D)5\d\d(\D|$)/i.test(detail);
      if (!transient || attempt === retries) throw e;
      const base = retryDelayMs ?? Number(process.env.FANHAN_NTN_RETRY_DELAY_MS || 300);
      await sleep(base * 2 ** attempt);
    }
  }
  throw last;
}

export async function ntnJson(args, input, opts = {}) {
  const { stdout } = await run(args, input, opts);
  const text = stdout.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`ntn 返回的不是合法 JSON：${text.slice(0, 300)}`);
  }
}

export async function whoami() {
  try {
    const { stdout } = await run(['whoami']);
    const line = stdout.trim();
    const cols = line.split('\t');
    const workspace = cols.length >= 6 ? cols[5] : line.split(/\s{2,}/).pop() || '';
    const email = (line.match(/[\w.+-]+@[\w.-]+/) || [''])[0];
    return { raw: line, workspace: workspace || email, email, ok: true };
  } catch (e) {
    return { raw: '', workspace: '', email: '', ok: false, error: e.message };
  }
}

export async function ntnVersion() {
  try {
    const { stdout } = await run(['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

function assertNotIncomplete(payload, label) {
  const status = payload?.request_status;
  const type = typeof status === 'string' ? status : status?.type;
  if (type === 'incomplete' || payload?.incomplete === true) {
    const reason = status?.incomplete_reason || status?.reason || payload?.incomplete_reason || 'unknown';
    throw new Error(`${label} 返回 request_status.incomplete（${reason}），拒绝发布不完整快照；旧缓存保持不变。`);
  }
}

/** 全量拉取一个 data source，自动翻页；任何不完整响应都失败。 */
export async function queryAll(dataSourceId, { pageSize = 100, onPage } = {}) {
  const rows = [];
  let cursor = null;
  let guard = 0;
  for (;;) {
    const args = ['datasources', 'query', dataSourceId, '--limit', String(pageSize), '--json'];
    if (cursor) args.push('--start-cursor', cursor);
    const payload = await ntnJson(args, undefined, { retries: 3 });
    assertNotIncomplete(payload, `数据源 ${dataSourceId}`);
    const results = payload.results || [];
    for (const row of results) assertNotIncomplete(row, `数据源 ${dataSourceId} 的某条记录`);
    rows.push(...results);
    if (onPage) onPage(rows.length, payload.has_more);
    if (!payload.has_more) break;
    if (!payload.next_cursor) throw new Error('数据源返回 has_more=true 但没有 next_cursor，拒绝发布不完整快照。');
    cursor = payload.next_cursor;
    if (++guard > 200) throw new Error('翻页次数异常，已中止');
  }
  return rows;
}

export async function fetchPage(pageId) {
  return ntnJson(['api', `/v1/pages/${pageId}`], undefined, { retries: 3 });
}

/**
 * 新鲜读取一个关系属性并完整翻页。
 * Notion 内联 relation 可能只给前 25 项；属性端点才是完整列表。
 */
export async function readRelation(pageId, propertyName, { pageSize = 100 } = {}) {
  const page = await fetchPage(pageId);
  const prop = page.properties?.[propertyName];
  if (!prop) {
    throw new Error(`页面 ${pageId} 缺少关系属性「${propertyName}」，无法安全合并；请先验证 Notion schema。`);
  }
  if (prop.type && prop.type !== 'relation') {
    throw new Error(`属性「${propertyName}」类型为 ${prop.type}，不是 relation；拒绝写入。`);
  }
  const initial = (prop.relation || []).map((r) => r.id).filter(Boolean);
  const needsPagination = prop.has_more === true || initial.length >= 25;
  if (!needsPagination) return { ids: [...new Set(initial)], page, property: prop, paginated: false };

  const propId = prop.id || propertyName;
  const ids = [...initial];
  let cursor = null;
  let guard = 0;
  for (;;) {
    const qs = new URLSearchParams({ page_size: String(pageSize) });
    if (cursor) qs.set('start_cursor', cursor);
    const payload = await ntnJson(
      ['api', `/v1/pages/${pageId}/properties/${propId}?${qs.toString()}`],
      undefined,
      { retries: 3 },
    );
    assertNotIncomplete(payload, `关系属性「${propertyName}」`);
    for (const item of payload.results || []) if (item?.id) ids.push(item.id);
    if (!payload.has_more) break;
    if (!payload.next_cursor) throw new Error(`关系属性「${propertyName}」返回 has_more=true 但没有 next_cursor。`);
    cursor = payload.next_cursor;
    if (++guard > 200) throw new Error('关系属性翻页次数异常，已中止');
  }
  return { ids: [...new Set(ids)], page, property: prop, paginated: true };
}

/** 写回：更新页面属性（关系等）。写操作不自动重试，避免重复提交。 */
export async function updatePage(pageId, properties) {
  return ntnJson(['api', `/v1/pages/${pageId}`, '-X', 'PATCH', '-d', '@-'], JSON.stringify({ properties }));
}

export async function verifyRelation(pageId, propertyName, expectedIds, opts = {}) {
  const fresh = await readRelation(pageId, propertyName, opts);
  const have = new Set(fresh.ids);
  const missing = expectedIds.filter((id) => !have.has(id));
  return { ok: missing.length === 0, ids: fresh.ids, missing, paginated: fresh.paginated };
}

export function extractPageId(input) {
  if (!input) return null;
  const m = String(input).match(/([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (!m) return null;
  const raw = m[1].replace(/-/g, '');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** 本地单机锁：只防同一台机器上的并发写，不能提供跨机器原子性。 */
export function acquireLock(dir, name = 'cache', { staleMs = 5 * 60_000 } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const lockFile = path.join(dir, `${name}.lock`);
  const tryCreate = () => {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    fs.closeSync(fd);
  };
  try {
    tryCreate();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let stale = false;
    try {
      const st = fs.statSync(lockFile);
      stale = Date.now() - st.mtimeMs > staleMs;
    } catch {}
    if (!stale) throw new Error(`本地锁被占用：${lockFile}。另一个 fanhan-ntn 进程可能正在写；请稍后重试。`);
    try { fs.unlinkSync(lockFile); } catch {}
    try { tryCreate(); } catch (e2) {
      if (e2.code === 'EEXIST') throw new Error(`本地锁被占用：${lockFile}。`);
      throw e2;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.unlinkSync(lockFile); } catch {}
  };
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

export function writeFileAtomic(file, content, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content);
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = undefined;
    try { fs.chmodSync(tmp, mode); } catch {}
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, mode); } catch {}
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}
