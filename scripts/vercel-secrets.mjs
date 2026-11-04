#!/usr/bin/env node
// Add the server-side secrets the Vercel functions need, as Sensitive env vars on Production and Preview.
//
//   node scripts/vercel-secrets.mjs                 BRIDGE_KEY + RELAYER_KEY from contracts/.env PRIVATE_KEY
//   node scripts/vercel-secrets.mjs --dry-run       show what would be set, change nothing
//   WALLETCONNECT_PROJECT_ID=… node scripts/vercel-secrets.mjs   also set VITE_WALLETCONNECT_PROJECT_ID
//
// Values are read from files and sent through `vercel api`; they are never printed or passed on a command
// line. An existing variable with the same key and target is replaced. Needs the Vercel CLI, logged in.
// Redeploy afterwards: functions only see new variables on the next deployment.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { projectId, orgId } = JSON.parse(readFileSync(path.join(root, 'frontend/.vercel/project.json'), 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const TARGETS = ['production', 'preview'];

function envFile(file, name) {
  const m = readFileSync(path.join(root, file), 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (!m || !m[1].trim()) throw new Error(`${name} not found in ${file}`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}
const hex = (k) => (k.startsWith('0x') ? k : `0x${k}`);

const deployerKey = hex(envFile('contracts/.env', 'PRIVATE_KEY'));
const vars = [
  { key: 'BRIDGE_KEY', value: deployerKey, type: 'sensitive' },
  { key: 'RELAYER_KEY', value: deployerKey, type: 'sensitive' },
];
if (process.env.WALLETCONNECT_PROJECT_ID) {
  // Public by design (it ships in the browser bundle), so plain rather than sensitive.
  vars.push({ key: 'VITE_WALLETCONNECT_PROJECT_ID', value: process.env.WALLETCONNECT_PROJECT_ID, type: 'plain' });
}

function api(route, method, body) {
  const args = ['api', `${route}${route.includes('?') ? '&' : '?'}teamId=${orgId}`, '--method', method];
  let dir;
  if (body) {
    dir = mkdtempSync(path.join(tmpdir(), 'vsec-'));
    const f = path.join(dir, 'body.json');
    writeFileSync(f, JSON.stringify(body), { mode: 0o600 });
    args.push('--input', f);
  }
  try {
    const out = execFileSync('vercel', args, { cwd: path.join(root, 'frontend'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(out.slice(out.indexOf('{')));
  } catch (e) {
    throw new Error(`vercel api ${method} failed: ${(e.stderr || e.stdout || '').toString().split('\n').find((l) => l.trim()) ?? 'unknown error'}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const existing = api(`/v10/projects/${projectId}/env`, 'GET').envs ?? [];
for (const v of vars) {
  const old = existing.filter((e) => e.key === v.key && e.target?.some((t) => TARGETS.includes(t)));
  console.log(`${v.key} → ${TARGETS.join(' + ')} (${v.type})${old.length ? `, replacing ${old.length} existing` : ''}`);
  if (dryRun) continue;
  for (const e of old) api(`/v9/projects/${projectId}/env/${e.id}`, 'DELETE');
  const res = api(`/v10/projects/${projectId}/env`, 'POST', { ...v, target: TARGETS });
  if (res.error) throw new Error(`${v.key}: ${res.error.message ?? JSON.stringify(res.error)}`);
}
console.log(dryRun ? 'Dry run: nothing changed.' : 'Done. Redeploy (merge a PR, or Redeploy in the dashboard) to use them.');
