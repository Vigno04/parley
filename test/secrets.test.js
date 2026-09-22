// test/secrets.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { upsertEnvLine, connectionStatus, setConnection } from '../src/store/secrets.js';

test('upsertEnvLine replaces an existing key in place', () => {
  const text = 'A=1\nDISCORD_TOKEN=old\nB=2\n';
  const out = upsertEnvLine(text, 'DISCORD_TOKEN', 'new');
  assert.equal(out, 'A=1\nDISCORD_TOKEN=new\nB=2\n');
});

test('upsertEnvLine replaces an empty/commented-style key', () => {
  const text = 'DISCORD_TOKEN=\nB=2\n';
  assert.equal(upsertEnvLine(text, 'DISCORD_TOKEN', 'abc'), 'DISCORD_TOKEN=abc\nB=2\n');
});

test('upsertEnvLine appends a missing key with a trailing newline', () => {
  assert.equal(upsertEnvLine('A=1', 'DISCORD_TOKEN', 'sk'), 'A=1\nDISCORD_TOKEN=sk\n');
  assert.equal(upsertEnvLine('', 'DISCORD_TOKEN', 'sk'), 'DISCORD_TOKEN=sk\n');
});

test('connectionStatus reports presence for the token and values for the rest', () => {
  const env = { discordToken: 'abc', discordClientId: '123', sttUrl: 'http://x:8000' };
  const s = connectionStatus(env);
  assert.equal(s.discordToken.set, true);
  assert.equal('value' in s.discordToken, false); // never leaks the token value
  assert.equal(s.discordClientId.value, '123');
  assert.equal(s.sttUrl.value, 'http://x:8000');
});

test('setConnection applies live + persists, ignoring unknown keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conn-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_TOKEN=\nDISCORD_CLIENT_ID=\n');
  const env = { discordToken: undefined, discordClientId: undefined, sttUrl: undefined };

  const status = await setConnection(
    { discordToken: '  tok  ', discordClientId: '999', sttUrl: 'http://sidecar:8000', bogus: 'nope' },
    { env, envPath },
  );
  assert.equal(env.discordToken, 'tok');          // trimmed + live
  assert.equal(env.discordClientId, '999');
  assert.equal(env.sttUrl, 'http://sidecar:8000');
  assert.equal(status.discordClientId.value, '999');
  const text = readFileSync(envPath, 'utf8');
  assert.match(text, /DISCORD_TOKEN=tok/);
  assert.match(text, /DISCORD_CLIENT_ID=999/);
  assert.match(text, /STT_URL=http:\/\/sidecar:8000/);
  assert.doesNotMatch(text, /bogus/);

  rmSync(dir, { recursive: true, force: true });
});

test('setConnection clearing the STT url falls back to the default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-conn2-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: 'http://old:8000' };
  await setConnection({ sttUrl: '' }, { env, envPath });
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000');
  rmSync(dir, { recursive: true, force: true });
});

// ── Injection / SSRF hardening ────────────────────────────────────────────────

test('setConnection rejects a value with embedded newlines (.env injection)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-inject-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, 'DISCORD_CLIENT_ID=\n');
  const env = { discordToken: undefined, discordClientId: 'safe', sttUrl: undefined };
  await assert.rejects(
    () => setConnection({ discordClientId: 'x\nEVIL=true' }, { env, envPath }),
    /control characters/,
  );
  assert.equal(env.discordClientId, 'safe');
  assert.doesNotMatch(readFileSync(envPath, 'utf8'), /EVIL/);
  rmSync(dir, { recursive: true, force: true });
});

test('setConnection rejects an STT url pointing at cloud metadata (SSRF)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-ssrf-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(
    () => setConnection({ sttUrl: 'http://169.254.169.254/latest/meta-data' }, { env, envPath }),
    /blocked address/,
  );
  assert.equal(env.sttUrl, 'http://127.0.0.1:8000'); // unchanged
  rmSync(dir, { recursive: true, force: true });
});

test('setConnection rejects a non-http STT url', async () => {
  const env = { sttUrl: 'http://127.0.0.1:8000' };
  await assert.rejects(
    () => setConnection({ sttUrl: 'file:///etc/passwd' }, { env, envPath: '/tmp/none-xyz' }),
    /http or https/,
  );
});

test('setConnection allows a normal LAN sidecar url', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'parley-lan-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, '');
  const env = { sttUrl: undefined };
  await setConnection({ sttUrl: 'http://192.168.1.50:8000' }, { env, envPath });
  assert.equal(env.sttUrl, 'http://192.168.1.50:8000'); // private ranges are fine
  rmSync(dir, { recursive: true, force: true });
});

test('upsertEnvLine escapes regex metacharacters in the key', () => {
  const text = 'A.B=old\nC=2\n';
  assert.equal(upsertEnvLine(text, 'A.B', 'new'), 'A.B=new\nC=2\n');
});
