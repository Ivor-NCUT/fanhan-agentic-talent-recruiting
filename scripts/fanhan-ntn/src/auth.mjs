import { spawn, execFileSync } from 'node:child_process';

const SERVICE = 'fanhan-ntn-llm';
const ACCOUNT = 'default';

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(Buffer.concat(err).toString() || `exit ${code}`)),
    );
    if (input !== undefined) p.stdin.end(input);
    else p.stdin.end();
  });
}

export function readKeyFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const v = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

export async function saveKeyToKeychain(key) {
  if (process.platform !== 'darwin') throw new Error('Keychain 仅支持 macOS；其它平台请用 FANHAN_LLM_API_KEY 环境变量');
  const clean = String(key).trim();
  if (clean.length < 10) throw new Error('key 看起来不完整');
  await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w'], clean);
  return true;
}

export async function deleteKeyFromKeychain() {
  if (process.platform !== 'darwin') throw new Error('仅支持 macOS');
  try {
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
    return true;
  } catch {
    return false;
  }
}

export async function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString().trim()));
    process.stdin.resume();
  });
}
