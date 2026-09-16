#!/usr/bin/env node

/**
 * Remote Workers prep, matching GMShop Edge:
 * create or reuse the named D1 database, apply migrations, then build
 * dashboard assets. Account-specific IDs are never written to wrangler.jsonc.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = resolve(ROOT, 'packages/worker');
const WRANGLER_JSONC = resolve(WORKER_DIR, 'wrangler.jsonc');
const DEPLOY_CONFIG = resolve(WORKER_DIR, '.wrangler.deploy.jsonc');

function run(command, args, cwd = WORKER_DIR) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function capture(command, args, cwd = WORKER_DIR) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const combined = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;
    error.combined = combined;
    throw error;
  }
}

function readDatabaseName() {
  const source = readFileSync(WRANGLER_JSONC, 'utf8');
  const match = source.match(/"database_name"\s*:\s*"([^"]+)"/);
  if (!match) {
    throw new Error('packages/worker/wrangler.jsonc is missing d1_databases.database_name');
  }
  return match[1];
}

function parseD1List(raw) {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

function listDatabases() {
  return parseD1List(capture('npx', ['wrangler', 'd1', 'list', '--json']));
}

function lookupDatabaseId(name) {
  try {
    const found = listDatabases().find((db) => db.name === name);
    return found?.uuid || found?.id || null;
  } catch {
    return null;
  }
}

function writeDeployConfig(databaseId) {
  let config = readFileSync(WRANGLER_JSONC, 'utf8');
  if (/"database_id"\s*:\s*"[^"]+"/.test(config)) {
    config = config.replace(/"database_id"\s*:\s*"[^"]+"/, `"database_id": "${databaseId}"`);
  } else {
    config = config.replace(/("database_name"\s*:\s*"[^"]+")/, `$1,\n      "database_id": "${databaseId}"`);
  }
  writeFileSync(DEPLOY_CONFIG, config);
}

function ensureD1(name) {
  let databaseId = lookupDatabaseId(name);
  if (databaseId) {
    console.log(`  Reusing D1 database ${name}`);
  } else {
    try {
      const created = capture('npx', ['wrangler', 'd1', 'create', name]);
      const match = created.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
      databaseId = match?.[0] || lookupDatabaseId(name);
      console.log(`  Created D1 database ${name}`);
    } catch (error) {
      if (/already exists/i.test(error.combined || '')) {
        databaseId = lookupDatabaseId(name);
        console.log(`  Reusing D1 database ${name}`);
      } else {
        throw error;
      }
    }
  }
  if (!databaseId) {
    throw new Error(`Could not resolve D1 database ${name}`);
  }
  writeDeployConfig(databaseId);
  return databaseId;
}

function main() {
  const databaseName = readDatabaseName();
  console.log(`\n[predeploy] prepare ${databaseName}`);
  ensureD1(databaseName);
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', DEPLOY_CONFIG]);
  run('pnpm', ['--filter', '@aiusage/dashboard', 'build'], ROOT);
  run('pnpm', ['--filter', '@aiusage/worker', 'build'], ROOT);
  console.log('[predeploy] ready (wrangler.jsonc unchanged)\n');
}

main();
