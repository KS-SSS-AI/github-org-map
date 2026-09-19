import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveToken } from '../scripts/lib/github.js';

// Snapshot and restore the env vars this file touches around every test, so
// a failing assertion never leaks state into the next test or another file.
const TRACKED_VARS = ['ORG_READ_TOKEN', 'GITHUB_TOKEN', 'USER_READ_TOKEN', 'CUSTOM_TOKEN'];

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(TRACKED_VARS.map((name) => [name, process.env[name]]));
  try {
    for (const name of TRACKED_VARS) {
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(vars)) {
      if (value !== undefined) process.env[name] = value;
    }
    fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('resolveToken(envName): reads exactly that variable', () => {
  withEnv({ CUSTOM_TOKEN: 'abc123' }, () => {
    assert.equal(resolveToken('CUSTOM_TOKEN'), 'abc123');
  });
});

test('resolveToken(envName): throws naming that variable when it is missing, with no fallback', () => {
  // ORG_READ_TOKEN is set, but a named envName must never fall back to it —
  // a silent fallback would quietly read the wrong owner's repos.
  withEnv({ ORG_READ_TOKEN: 'org-token' }, () => {
    assert.throws(() => resolveToken('USER_READ_TOKEN'), /USER_READ_TOKEN/);
  });
});

test('resolveToken(envName): throws naming that variable when it is empty after trimming', () => {
  withEnv({ CUSTOM_TOKEN: '   ' }, () => {
    assert.throws(() => resolveToken('CUSTOM_TOKEN'), /CUSTOM_TOKEN/);
  });
});

test('resolveToken(): no-arg fallback order is ORG_READ_TOKEN then GITHUB_TOKEN', () => {
  withEnv({ ORG_READ_TOKEN: 'org-token', GITHUB_TOKEN: 'gh-token' }, () => {
    assert.equal(resolveToken(), 'org-token');
  });
  withEnv({ GITHUB_TOKEN: 'gh-token' }, () => {
    assert.equal(resolveToken(), 'gh-token');
  });
});

test('resolveToken(): throws when neither ORG_READ_TOKEN nor GITHUB_TOKEN is set', () => {
  withEnv({}, () => {
    assert.throws(() => resolveToken(), /ORG_READ_TOKEN/);
  });
});

test('resolveToken(envName): strips a leading/trailing BOM and surrounding whitespace', () => {
  withEnv({ CUSTOM_TOKEN: '﻿  abc123  ﻿' }, () => {
    assert.equal(resolveToken('CUSTOM_TOKEN'), 'abc123');
  });
});

test('resolveToken(envName): rejects a non-printable-ASCII character, naming the index', () => {
  withEnv({ CUSTOM_TOKEN: 'abcé123' }, () => {
    assert.throws(() => resolveToken('CUSTOM_TOKEN'), /index 3/);
  });
});

test('resolveToken(envName): the thrown message never includes the token value itself', () => {
  withEnv({ CUSTOM_TOKEN: 'abcé123' }, () => {
    try {
      resolveToken('CUSTOM_TOKEN');
      assert.fail('expected resolveToken to throw');
    } catch (err) {
      const message = (err as Error).message;
      assert.ok(!message.includes('abcé123'));
    }
  });
});
