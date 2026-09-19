import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertUniqueMaskedLabels,
  computeMaskHash,
  isExcludedFromPublicMap,
  maskPublicLabel,
  toPublicRepo,
} from '../scripts/lib/mask.js';
import { buildGroups, buildPublicSummaryMetrics, filterPublicRepos } from '../scripts/generate.js';
import type { NormalizedRepo, PrivateNormalizedRepo, PublicNormalizedRepo } from '../scripts/lib/github.js';

const SALT_A = 'test-salt-a-do-not-use-in-production';
const SALT_B = 'test-salt-b-different-from-a';

test('maskPublicLabel: same name + same salt gives the same label (stable)', () => {
  const first = maskPublicLabel('acme/secret-project', SALT_A);
  const second = maskPublicLabel('acme/secret-project', SALT_A);
  assert.equal(first, second);
});

test('maskPublicLabel: same name + different salt gives a different label', () => {
  const withSaltA = maskPublicLabel('acme/secret-project', SALT_A);
  const withSaltB = maskPublicLabel('acme/secret-project', SALT_B);
  assert.notEqual(withSaltA, withSaltB);
});

test('maskPublicLabel: the label contains no character of the raw name', () => {
  // Deliberately built from letters that are never valid hex digits (hex is
  // 0-9a-f, so g-z are safe) and no digits, so this check is a real
  // guarantee rather than something that happens to pass because a hex
  // digit in the hash coincidentally matches a letter in the name — the
  // label's only content is the fixed dot run ('·', never an ASCII letter)
  // and the salted hash (only 0-9a-f), and v9 removed the old name prefix
  // that used to leak the name's own characters into the label.
  const name = 'zulu-monitoring-tool-lookup-story-spotlight-outpost-kilo-night';
  const label = maskPublicLabel(`acme/${name}`, SALT_A);
  for (const ch of name) {
    if (ch === '-') continue; // punctuation, not a name character
    assert.ok(!label.includes(ch), `label "${label}" must not contain "${ch}" from raw name "${name}"`);
  }
  assert.ok(!label.includes(name), `label "${label}" must not contain raw name "${name}"`);
  assert.notEqual(label, name);
});

test('maskPublicLabel: labels of wildly different real-name lengths are identical in length', () => {
  const shortLabel = maskPublicLabel('acme/a', SALT_A);
  const longLabel = maskPublicLabel(
    'acme/a-very-long-internal-repository-name-that-goes-on-and-on-and-on',
    SALT_A
  );
  assert.equal(shortLabel.length, longLabel.length);
  // Fixed at 6 dots + 6 hex hash chars (v9: no name prefix at all).
  assert.equal(shortLabel.length, 6 + 6);
});

test('maskPublicLabel: two different names do not collide across a real-world-like set', () => {
  const names = [
    'infra',
    'api',
    'web',
    'bot',
    'payments-service',
    'internal-tools',
    'secret-project',
    'ai-pipeline',
    'kubernetes-configs',
    'terraform-modules',
    'legacy-billing',
    'customer-data-sync',
  ];
  const labels = names.map((name) => maskPublicLabel(`acme/${name}`, SALT_A));
  const unique = new Set(labels);
  assert.equal(unique.size, labels.length, `expected ${labels.length} unique labels, got ${unique.size}`);
  // And the assertion helper agrees this set is fine.
  assert.doesNotThrow(() => assertUniqueMaskedLabels(labels));
});

test('maskPublicLabel: throws when salt is missing or empty', () => {
  assert.throws(() => maskPublicLabel('acme/secret', ''));
  // @ts-expect-error - deliberately passing undefined to check the runtime guard
  assert.throws(() => maskPublicLabel('acme/secret', undefined));
});

test('computeMaskHash: is what maskPublicLabel derives its hash suffix from', () => {
  const ownerAndName = 'acme/secret-project';
  const hash = computeMaskHash(ownerAndName, SALT_A);
  const label = maskPublicLabel(ownerAndName, SALT_A);
  assert.ok(label.endsWith(hash));
  assert.equal(hash.length, 6);
});

test('assertUniqueMaskedLabels: passes on a set with no duplicates', () => {
  assert.doesNotThrow(() => assertUniqueMaskedLabels(['aaa111', 'bbb222', 'ccc333']));
});

test('assertUniqueMaskedLabels: throws on a deliberately duplicated label list, naming no repository', () => {
  // Constructing a real HMAC collision cheaply isn't practical (24 bits of
  // digest), so this exercises the assertion function directly with a
  // duplicated label list instead.
  let thrown: unknown;
  try {
    assertUniqueMaskedLabels(['dup1ab', 'dup1ab', 'unique2']);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof Error, 'expected assertUniqueMaskedLabels to throw');
  const message = (thrown as Error).message;
  assert.match(message, /collision/i);
  assert.match(message, /2/); // "how many labels were involved"
  // The two colliding labels are deliberately generic test fixtures, not
  // real repo names, but assert the message doesn't echo them either way —
  // the contract is "never naming any repository".
  assert.ok(!message.includes('dup1ab'));
});

function makePrivateRepo(overrides: Partial<PrivateNormalizedRepo> = {}): PrivateNormalizedRepo {
  return {
    owner: 'acme',
    name: 'secret-project',
    isPrivate: true,
    visibility: 'private',
    language: null,
    fork: false,
    archived: false,
    stargazers: 0,
    updatedAt: null,
    ...overrides,
  };
}

function makePublicRepo(overrides: Partial<PublicNormalizedRepo> = {}): PublicNormalizedRepo {
  return {
    owner: 'acme',
    name: 'public-project',
    isPrivate: false,
    visibility: 'public',
    description: 'an open source tool',
    topics: ['oss'],
    language: 'JavaScript',
    fork: false,
    archived: false,
    stargazers: 0,
    updatedAt: null,
    ...overrides,
  };
}

test('toPublicRepo: masks the name and drops description/topics/language for private repos', () => {
  const repo = makePrivateRepo();
  const safe = toPublicRepo(repo, SALT_A);

  assert.notEqual(safe.name, repo.name);
  assert.equal(safe.name, maskPublicLabel(`${repo.owner}/${repo.name}`, SALT_A));
  assert.ok(!('description' in safe), 'description must not be present for private repos');
  assert.ok(!('topics' in safe), 'topics must not be present for private repos');
  assert.equal(safe.language, null);
});

test('toPublicRepo: forces language to null for private repos even if the input carried one (defense-in-depth)', () => {
  // The real pipeline (github.ts normalizeRepo) never sets a private repo's
  // language to anything but null, but toPublicRepo should not trust that
  // invariant blindly.
  const repo = makePrivateRepo({ language: 'TypeScript' });
  const safe = toPublicRepo(repo, SALT_A);
  assert.equal(safe.language, null);
});

test('toPublicRepo: preserves name/description/topics/language for public repos', () => {
  const repo = makePublicRepo();
  const safe = toPublicRepo(repo, SALT_A);
  assert.deepEqual(safe, repo);
});

test('toPublicRepo: missing salt throws (fail closed)', () => {
  const repo = makePrivateRepo();
  assert.throws(() => toPublicRepo(repo, ''));
  // @ts-expect-error - deliberately passing undefined to check the runtime guard
  assert.throws(() => toPublicRepo(repo, undefined));
});

test('isExcludedFromPublicMap: a dot-prefixed name is excluded regardless of its hash', () => {
  const hash = computeMaskHash('acme/.github', SALT_A);
  assert.equal(isExcludedFromPublicMap('.github', hash, []), true);
});

test('isExcludedFromPublicMap: a hash present in publicExcludeHashes is excluded', () => {
  const ownerAndName = 'acme/internal-only-tool';
  const hash = computeMaskHash(ownerAndName, SALT_A);
  assert.equal(isExcludedFromPublicMap('internal-only-tool', hash, [hash]), true);
});

test('isExcludedFromPublicMap: a repo matching neither rule is not excluded', () => {
  const ownerAndName = 'acme/normal-repo';
  const hash = computeMaskHash(ownerAndName, SALT_A);
  assert.equal(isExcludedFromPublicMap('normal-repo', hash, ['someOtherHash']), false);
});

function makeNormalizedRepo(
  owner: string,
  name: string,
  isPrivate: boolean,
  overrides: Record<string, unknown> = {}
): NormalizedRepo {
  const base = {
    owner,
    name,
    visibility: isPrivate ? 'private' : 'public',
    fork: false,
    archived: false,
    language: isPrivate ? null : 'JavaScript',
    stargazers: 0,
    updatedAt: null,
  };
  if (isPrivate) {
    return { ...base, isPrivate: true, ...overrides } as PrivateNormalizedRepo;
  }
  return {
    ...base,
    isPrivate: false,
    description: null,
    topics: [],
    ...overrides,
  } as PublicNormalizedRepo;
}

test('filterPublicRepos: excludes dot-prefixed and hash-listed repos, keeps the rest', () => {
  const keep = makeNormalizedRepo('acme', 'keep-me', true);
  const dotExcluded = makeNormalizedRepo('acme', '.github', true);
  const hashExcludedOwnerAndName = 'acme/exclude-by-hash';
  const hashExcludedHash = computeMaskHash(hashExcludedOwnerAndName, SALT_A);
  const hashExcluded = makeNormalizedRepo('acme', 'exclude-by-hash', true);

  const result = filterPublicRepos(
    [keep, dotExcluded, hashExcluded],
    SALT_A,
    [hashExcludedHash]
  );

  assert.deepEqual(
    result.map((r) => r.name),
    ['keep-me']
  );
});

test('buildGroups + buildPublicSummaryMetrics: excluded repos are absent from rows and from the summary count', () => {
  const config = { account: 'acme', orgs: [] };
  const kept = makeNormalizedRepo('acme', 'kept-repo', true);
  const dotExcluded = makeNormalizedRepo('acme', '.profile', true);
  const excludedOwnerAndName = 'acme/hidden-repo';
  const excludedHash = computeMaskHash(excludedOwnerAndName, SALT_A);
  const hashExcluded = makeNormalizedRepo('acme', 'hidden-repo', true);
  const publicRepo = makeNormalizedRepo('acme', 'oss-repo', false);

  const filtered = filterPublicRepos(
    [kept, dotExcluded, hashExcluded, publicRepo],
    SALT_A,
    [excludedHash]
  );

  const groups = buildGroups(config, filtered, (repo) => toPublicRepo(repo, SALT_A));
  const summary = buildPublicSummaryMetrics(filtered);

  const allNames = groups.flatMap((g) => g.repos.map((r) => r.name));
  assert.ok(!allNames.includes('.profile'));
  assert.ok(!allNames.includes('hidden-repo'));
  // Only 1 private repo (kept-repo) and 1 public repo (oss-repo) remain.
  assert.equal(summary.privateCount, 1);
  assert.equal(summary.publicCount, 1);
});

test('buildGroups: does not itself impose an order (caller sorts by label string)', () => {
  // buildGroups itself just maps; the sort is applied by the caller
  // (scripts/generate.ts's main()). This test verifies the building block
  // buildGroups produces repos in input order, which is the precondition
  // the caller's sort relies on being meaningful to apply afterwards.
  const config = { account: 'acme', orgs: [] };
  const repoB = makeNormalizedRepo('acme', 'repo-b', false);
  const repoA = makeNormalizedRepo('acme', 'repo-a', false);
  const groups = buildGroups(config, [repoB, repoA], (repo) => toPublicRepo(repo, SALT_A));
  assert.deepEqual(
    groups[0].repos.map((r) => r.name),
    ['repo-b', 'repo-a']
  );
});
