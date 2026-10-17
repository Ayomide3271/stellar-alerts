import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { addedLines, findSecretsInPatch, formatFinding } from './check-secrets.mjs';

function patchFor(file, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

test('reads only added lines and preserves new-file line numbers', () => {
  const token = 'ghp_' + 'A1'.repeat(20);
  const patch = [
    'diff --git a/example.txt b/example.txt',
    '--- a/example.txt',
    '+++ b/example.txt',
    '@@ -1,2 +1,3 @@',
    `-${token}`,
    '+ordinary text',
    ' unchanged',
    '+second added line',
  ].join('\n');

  assert.deepEqual([...addedLines(patch)], [
    { file: 'example.txt', line: 1, text: 'ordinary text' },
    { file: 'example.txt', line: 3, text: 'second added line' },
  ]);
  assert.deepEqual(findSecretsInPatch(patch), []);
});

test('detects known token formats and private keys without returning their values', () => {
  const secrets = [
    '-----BEGIN ' + 'PRIVATE KEY-----',
    'S' + 'A'.repeat(55),
    'ghp_' + 'A1'.repeat(20),
    'AKIA' + 'A1'.repeat(8),
    'sk_' + 'live_' + 'A1'.repeat(10),
    'xoxb-' + 'A1'.repeat(12),
    '123456789:' + 'A1'.repeat(18),
  ];
  const findings = findSecretsInPatch(patchFor('added.env', secrets));

  assert.deepEqual(findings.map(({ kind }) => kind), [
    'PEM private key',
    'Stellar secret seed',
    'GitHub token',
    'AWS access key ID',
    'Stripe live key',
    'Slack token',
    'Telegram bot token',
  ]);
  const output = findings.map(formatFinding).join('\n');
  for (const secret of secrets) assert.equal(output.includes(secret), false);
  assert.match(output, /added\.env:1: potential PEM private key/);
});

test('flags a high-confidence assigned secret but accepts documented placeholders', () => {
  const secret = 'abcdefghijklm' + 'NOPQRSTUVWXYZ0123456789';
  const patch = patchFor('config.env', [
    'JWT_SECRET=your-super-secret-jwt-key',
    'JWT_SECRET=test-super-secret-jwt-key-12345',
    'NEXTAUTH_SECRET=ci-build-dummy-secret-key-123456',
    `API_KEY=${secret}`,
  ]);

  const findings = findSecretsInPatch(patch);
  assert.deepEqual(findings, [
    { kind: 'sensitive assignment', file: 'config.env', line: 4 },
  ]);
  assert.equal(formatFinding(findings[0]).includes(secret), false);
});

test('recognizes JS, JSON, YAML, and camel-case secret assignments', () => {
  const secret = 'abcdefghijklm' + 'NOPQRSTUVWXYZ0123456789';
  const patch = patchFor('src/config.ts', [
    `const apiKey = "${secret}";`,
    `"clientSecret": "${secret}",`,
    `authToken: ${secret}`,
    `export const privateKey = '${secret}';`,
    'const apiKey = "your-placeholder-key-1234567890";',
  ]);

  assert.deepEqual(findSecretsInPatch(patch), [
    { kind: 'sensitive assignment', file: 'src/config.ts', line: 1 },
    { kind: 'sensitive assignment', file: 'src/config.ts', line: 2 },
    { kind: 'sensitive assignment', file: 'src/config.ts', line: 3 },
    { kind: 'sensitive assignment', file: 'src/config.ts', line: 4 },
  ]);
});

test('does not mistake expressions or environment references for literal secrets', () => {
  const patch = patchFor('src/config.ts', [
    'const clientSecret = getOAuth2ClientSecret();',
    'const apiKey = process.env.API_KEY_VERSION2;',
    'privateKey: loadPkcs8PrivateKey()',
  ]);

  assert.deepEqual(findSecretsInPatch(patch), []);
});

test('does not scan deleted files, binary markers, or diff headers', () => {
  const token = 'ghp_' + 'A1'.repeat(20);
  const patch = [
    'diff --git a/removed.txt b/removed.txt',
    '--- a/removed.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-${token}`,
    'diff --git a/image.png b/image.png',
    'Binary files a/image.png and b/image.png differ',
  ].join('\n');

  assert.deepEqual(findSecretsInPatch(patch), []);
});

test('staged and commit-range scans fail without printing a detected value', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'stellar-secret-check-'));
  const script = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url));
  const secret = 'S' + 'A'.repeat(55);
  const git = (...args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();

  try {
    git('init', '-q');
    writeFileSync(path.join(directory, 'config.env'), 'SAFE=true\n');
    git('add', 'config.env');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');

    writeFileSync(path.join(directory, 'config.env'), `SAFE=true\nSTELLAR_SECRET=${secret}\n`);
    git('add', 'config.env');
    const staged = spawnSync(process.execPath, [script, '--staged'], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(staged.status, 1);
    assert.match(staged.stderr, /Stellar secret seed/);
    assert.equal(staged.stderr.includes(secret), false);

    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'new secret');
    const head = git('rev-parse', 'HEAD');
    const range = spawnSync(process.execPath, [script, '--range', base, head], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(range.status, 1);
    assert.match(range.stderr, /Stellar secret seed/);
    assert.equal(range.stderr.includes(secret), false);

    writeFileSync(path.join(directory, 'config.env'), 'SAFE=true\n');
    git('add', 'config.env');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'remove secret');
    const cleanedHead = git('rev-parse', 'HEAD');
    const history = spawnSync(process.execPath, [script, '--range', base, cleanedHead], {
      cwd: directory, encoding: 'utf8',
    });
    assert.equal(history.status, 1);
    assert.match(history.stderr, /Stellar secret seed/);
    assert.equal(history.stderr.includes(secret), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
