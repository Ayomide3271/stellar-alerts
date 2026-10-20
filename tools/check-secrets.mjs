#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// These are deliberately high-confidence detectors. The scanner examines only
// lines added by a commit, so existing synthetic fixtures do not block a PR.
const DETECTORS = [
  ['PEM private key', /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['Stellar secret seed', /\bS[A-Z2-7]{55}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['AWS access key ID', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['Stripe live key', /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ['Telegram bot token', /\b[0-9]{8,10}:[A-Za-z0-9_-]{35,}\b/],
];

const SENSITIVE_NAME = /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|SIGNING_KEY|API_KEY|AUTH_KEY|CREDENTIALS?|SEED)(?:_|$)/;
const QUOTED_DECLARATION = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z][A-Za-z0-9_]*)(?:\s*:\s*string)?\s*=\s*(["'`])([^"'`]+)\2\s*[,;]?\s*(?:(?:#|\/\/).*)?$/;
const QUOTED_ASSIGNMENT = /^\s*(?:(?:process\.env|this)\.)?["']?([A-Za-z][A-Za-z0-9_]*)["']?\s*[:=]\s*(["'`])([^"'`]+)\2\s*[,;]?\s*(?:(?:#|\/\/).*)?$/;
const UNQUOTED_ASSIGNMENT = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*([A-Za-z0-9_+/-]+={0,2})\s*(?:#.*)?$/;
const PLACEHOLDER = /^(?:your[-_]|example|sample|dummy|test[-_]|ci[-_]|placeholder|changeme|generate[-_]|\$|<)/i;

/** Yield only added text lines, with their new-file line numbers. */
export function* addedLines(patch) {
  let file = null;
  let lineNumber = 0;
  let inHunk = false;

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const target = line.slice(4);
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const match = line.match(/\+(\d+)(?:,\d+)?\s@@/);
      inHunk = Boolean(match);
      lineNumber = match ? Number(match[1]) : 0;
      continue;
    }
    if (!inHunk || file === null) continue;

    if (line.startsWith('+')) {
      yield { file, line: lineNumber, text: line.slice(1) };
      lineNumber += 1;
    } else if (line.startsWith(' ')) {
      lineNumber += 1;
    }
  }
}

function looksLikeAssignedSecret(text) {
  const quoted = text.match(QUOTED_DECLARATION) || text.match(QUOTED_ASSIGNMENT);
  const unquoted = quoted ? null : text.match(UNQUOTED_ASSIGNMENT);
  if (!quoted && !unquoted) return false;
  const name = (quoted || unquoted)[1];
  const normalizedName = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  if (!SENSITIVE_NAME.test(normalizedName)) return false;

  const value = quoted ? quoted[3] : unquoted[2];
  if (PLACEHOLDER.test(value)) return false;
  // JWT signing secrets need not contain digits or look random to be sensitive.
  if (/^JWT_(?:SECRET|PRIVATE_KEY|SIGNING_KEY)$/.test(normalizedName)) {
    return value.length > 0;
  }
  if (value.length < 20) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return new Set(value).size >= 10;
}

/** Return detector names and locations; never retain or return matching values. */
export function findSecretsInPatch(patch) {
  const findings = [];
  for (const added of addedLines(patch)) {
    let kind = DETECTORS.find(([, pattern]) => pattern.test(added.text))?.[0];
    if (!kind && looksLikeAssignedSecret(added.text)) kind = 'sensitive assignment';
    if (kind) findings.push({ kind, file: added.file, line: added.line });
  }
  return findings;
}

export function formatFinding({ kind, file, line }) {
  const safeFile = file.replace(/[\x00-\x1f\x7f]/g, '?');
  return `${safeFile}:${line}: potential ${kind}`;
}

function readPatch(args) {
  const diffOptions = ['--no-color', '--no-ext-diff', '--no-renames', '--unified=0', '--diff-filter=ACMRT'];
  if (args.length === 1 && args[0] === '--staged') {
    return execFileSync('git', ['diff', ...diffOptions, '--cached', '--', '.'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  }
  if (args.length === 3 && args[0] === '--range' &&
      /^[a-fA-F0-9]{40}$/.test(args[1]) && /^[a-fA-F0-9]{40}$/.test(args[2])) {
    // Scan every commit, including merge resolutions, so removing a secret in
    // a later commit does not conceal its earlier introduction in PR history.
    return execFileSync('git', ['log', '-p', '-m', '--format=', ...diffOptions,
      `${args[1]}..${args[2]}`, '--', '.'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  }
  throw new Error('usage');
}

export function main(args = process.argv.slice(2)) {
  let patch;
  try {
    patch = readPatch(args);
  } catch (error) {
    console.error(error.message === 'usage'
      ? 'Usage: node tools/check-secrets.mjs --staged | --range BASE_SHA HEAD_SHA'
      : 'Unable to read the Git diff for secret scanning.');
    process.exitCode = 2;
    return;
  }

  const findings = findSecretsInPatch(patch);
  if (findings.length > 0) {
    for (const finding of findings) console.error(formatFinding(finding));
    console.error(`Secret scan found ${findings.length} potential secret(s). Commit blocked.`);
    console.error('Remove the secret from the file, use an environment variable, and stage the corrected file again.');
    console.error('To unstage a file: git restore --staged -- <file> (or git rm --cached -- <file> before the first commit).');
    console.error('If a real secret was already shared or committed, revoke/rotate it; removing the line does not erase history.');
    console.error('Only for reviewed synthetic fixtures: git commit --no-verify (bypasses all local hooks, not CI scanning).');
    process.exitCode = 1;
    return;
  }

  console.log('Secret scan passed: no known tokens or private keys in added lines.');
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) main();
