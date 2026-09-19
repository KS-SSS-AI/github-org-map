// Masking utilities for private repository names.
//
// This repository generates only the public map: it may end up published in
// a public repository / profile embed, so a private repo's real name,
// description, topics, language, and true name length must never reach it.
// `toPublicRepo` replaces a private repo's name with a salted-hash label via
// `maskPublicLabel` and drops the other fields; a public repo is passed
// through unchanged, since that information is already public on GitHub.
//
// Security contract: the salt (`MASK_SALT`) is the only thing standing
// between the masked label and a dictionary attack on common repo names, so
// it is required and never has a silent unsalted fallback — callers must
// fail closed.
//
// The label carries no characters of the real name at all (a visible prefix
// would let two repos be identified from context). The hash is 6 hex chars
// (24 bits) of the digest, and generation asserts label uniqueness instead
// of only hoping for it (see `assertUniqueMaskedLabels`).

import { createHmac } from 'node:crypto';

import type { NormalizedRepo, PrivateNormalizedRepo, PublicNormalizedRepo } from './github.js';

/** '·' MIDDLE DOT — used to fill the fixed-width run in a public mask label. */
const MASK_DOT_CHAR = '·';

// Fixed regardless of the real name's length, so the label never reveals how
// long the real name was. Chosen arbitrarily; any constant works as long as
// it stays constant.
const MASK_DOT_COUNT = 6;

// Hex characters taken from the HMAC digest. 6 hex chars = 24 bits of the
// digest — with the name prefix removed (v9), the hash is now the entire
// identifying part of the label, so it was widened from 4 to 6 hex chars to
// keep collisions unlikely at real-world repo-set sizes (see
// `assertUniqueMaskedLabels`, which still catches any collision that does
// occur rather than relying on width alone).
const HASH_HEX_LENGTH = 6;

/** A public display-safe repo: passed through unchanged from NormalizedRepo. */
export interface DisplaySafePublicRepo extends PublicNormalizedRepo {}

/**
 * A private display-safe repo: `name` is a salted mask label (see
 * `toPublicRepo`); description/topics are never present, matching
 * `PrivateNormalizedRepo`, and `language` is always null.
 */
export interface DisplaySafePrivateRepo extends PrivateNormalizedRepo {}

export type DisplaySafeRepo = DisplaySafePublicRepo | DisplaySafePrivateRepo;

/**
 * Compute the salted mask hash for one repo: the first `HASH_HEX_LENGTH` hex
 * characters of HMAC-SHA256(key = salt, message = ownerAndName).
 *
 * Split out from `maskPublicLabel` so the exclusion checks in
 * `isExcludedFromPublicMap` (`publicExcludeHashes` in data/config.json) can
 * compare against the same value the label is built from, without going
 * through label formatting (currently just dots + hash, but exclusion
 * matching should stay correct even if the label's cosmetic format changes
 * again).
 *
 * @param ownerAndName - `"owner/name"`, used as the HMAC message so identical
 *   repo names under different owners never collide.
 * @param salt - `MASK_SALT`. Required; never falls back to an unsalted hash.
 */
export function computeMaskHash(ownerAndName: string, salt: string): string {
  if (typeof ownerAndName !== 'string') {
    throw new TypeError('computeMaskHash expects ownerAndName to be a string');
  }
  if (!salt) {
    // Fail closed: an empty/missing salt would make the hash guessable via
    // dictionary attack, defeating the whole point of masking.
    throw new Error('computeMaskHash requires a non-empty salt (MASK_SALT).');
  }
  const digestHex = createHmac('sha256', salt).update(ownerAndName, 'utf8').digest('hex');
  return digestHex.slice(0, HASH_HEX_LENGTH);
}

/**
 * Compute the public-facing masked label for one private repo.
 *
 * Format: `<fixed dot run><6 hex chars>` — no characters of the real name
 * appear anywhere in the label (a visible prefix would let context narrow a
 * label down to a specific repo).
 *  - The dot run length never varies with `name`'s length, so the label
 *    never reveals the real name's true length, and every label has exactly
 *    the same length regardless of the real name.
 *  - The hash is HMAC-SHA256(key = salt, message = ownerAndName), so the
 *    same repo name under a different owner produces a different label, and
 *    without the salt the label cannot be matched against a dictionary of
 *    guessed names.
 *
 * @param ownerAndName - `"owner/name"`, used as the HMAC message so identical
 *   repo names under different owners never collide.
 * @param salt - `MASK_SALT`. Required; never falls back to an unsalted hash.
 */
export function maskPublicLabel(ownerAndName: string, salt: string): string {
  const dots = MASK_DOT_CHAR.repeat(MASK_DOT_COUNT);
  const hash = computeMaskHash(ownerAndName, salt);
  return `${dots}${hash}`;
}

/**
 * Assert that a set of masked labels contains no duplicates, and throw
 * (naming no repository) if it does.
 *
 * Intended to run once, right after the display groups are built and before
 * anything is written — see scripts/generate.ts. The 6 hex char hash (24
 * bits) makes a collision unlikely at this project's scale, but "unlikely"
 * is not the same as "impossible": a silent collision would make one repo's
 * row look like another's, or make a repo vanish from the count without any
 * indication of why. Fail loud instead.
 *
 * @param labels - the masked label of every private repo in the output
 *   (public repos keep their real name and are not part of this check).
 */
export function assertUniqueMaskedLabels(labels: string[]): void {
  if (!Array.isArray(labels)) {
    throw new TypeError('assertUniqueMaskedLabels expects an array of labels');
  }

  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  let collidingLabelCount = 0;
  for (const count of counts.values()) {
    if (count > 1) collidingLabelCount += count;
  }

  if (collidingLabelCount > 0) {
    throw new Error(
      `Masked label collision detected: ${collidingLabelCount} of ${labels.length} public labels ` +
        'are not unique. Refusing to generate the org map with a colliding label set.'
    );
  }
}

/**
 * Whether a repo is excluded from the public map entirely (not shown as a
 * row, not counted in the public summary — see scripts/generate.ts). Two
 * independent rules, either one is enough to exclude:
 *
 *  - The repo's name starts with `.` (e.g. a profile-README repo). This is a
 *    name-shape rule, not a config entry, so it applies automatically to any
 *    future repo without needing `publicExcludeHashes` updated.
 *  - The repo's mask hash (see `computeMaskHash`) is listed in
 *    `publicExcludeHashes` (data/config.json). The list holds hashes, never
 *    names — putting a real name in config would leak it the moment
 *    data/config.json is read.
 *
 * @param name - the repo's real name. Only used for the `.`-prefix check;
 *   never included in any thrown error or returned value.
 * @param hash - this repo's `computeMaskHash` result.
 * @param excludeHashes - `publicExcludeHashes` from data/config.json.
 */
export function isExcludedFromPublicMap(
  name: string,
  hash: string,
  excludeHashes: readonly string[]
): boolean {
  if (typeof name === 'string' && name.startsWith('.')) {
    return true;
  }
  return excludeHashes.includes(hash);
}

/**
 * Produce a display-safe copy of a repo record for the public map.
 *
 * Public repos are returned unchanged — their name, description, topics,
 * and language are already public information on GitHub. Private repos have
 * their name replaced with `maskPublicLabel`'s masked form; `description`
 * and `topics` are dropped entirely (free-form text cannot be safely
 * redacted with a fixed-position mask) and `language` is forced to `null`
 * as defense-in-depth even though it is already always `null` on a
 * `PrivateNormalizedRepo` coming out of github.ts's `normalizeRepo`.
 *
 * Exclusion (dot-prefixed names, `publicExcludeHashes`) is applied by the
 * caller before this function ever sees the repo — see
 * scripts/generate.ts's `filterPublicRepos`. This function only masks; it
 * does not decide what should be omitted.
 *
 * FAILS CLOSED: throws if `salt` is missing/empty rather than silently
 * falling back to an unsalted (dictionary-attackable) hash, and does so
 * before touching `repo` so nothing partial is ever produced.
 */
export function toPublicRepo(repo: NormalizedRepo, salt: string): DisplaySafeRepo {
  if (!repo || typeof repo !== 'object') {
    throw new TypeError('toPublicRepo expects a repo object');
  }
  if (!salt) {
    throw new Error(
      'toPublicRepo requires a non-empty salt (MASK_SALT). Refusing to generate the ' +
        'public variant without it — see README.md.'
    );
  }

  if (!repo.isPrivate) {
    return { ...repo };
  }

  const ownerAndName = `${repo.owner}/${repo.name}`;
  const maskedName = maskPublicLabel(ownerAndName, salt);

  // The intersection with optional `description`/`topics` is what makes
  // `delete` legal under `strict` mode (TS only allows deleting optional
  // properties). Structurally `PrivateNormalizedRepo` never carries these
  // fields to begin with; the deletes are defense-in-depth in case that
  // invariant is ever violated upstream (e.g. a malformed object slipping
  // through via `any`).
  const safe = { ...repo, name: maskedName, language: null } as DisplaySafePrivateRepo & {
    description?: unknown;
    topics?: unknown;
  };
  delete safe.description;
  delete safe.topics;
  return safe;
}
