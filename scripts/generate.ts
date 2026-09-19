// Main entry point: fetch repos for the configured account/orgs, render
// today's SVG map, append it to the dated history, and rebuild the GIF.
//
// This repository generates ONLY the public variant: private repos are
// masked (scripts/lib/mask.ts) before anything is written. Requires
// MASK_SALT; fails closed (throws, writes nothing) if it is missing. There is
// no private/unmasked variant here — see README.md.
//
// Rerunning this on the same day is idempotent: the history file for that
// date is simply overwritten with the freshly rendered SVG (same filename,
// no duplicate frames), and org-map.svg / org-map.gif are regenerated from
// scratch each run.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath, pathToFileURL } from 'node:url';

dns.setDefaultResultOrder?.('ipv4first');

import { fetchAllRepos, type NormalizedRepo } from './lib/github.js';
import {
  assertUniqueMaskedLabels,
  computeMaskHash,
  isExcludedFromPublicMap,
  toPublicRepo,
  type DisplaySafeRepo,
} from './lib/mask.js';
import { buildSvg, type Group, type SummaryMetrics } from './lib/svg.js';
import { buildGif, type GifOptions } from './lib/gif.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const HISTORY_DIR = path.join(ROOT, 'history');
const SVG_PATH = path.join(ROOT, 'org-map.svg');
const GIF_PATH = path.join(ROOT, 'org-map.gif');

interface Config {
  account: string;
  orgs?: string[];
  /** See github.ts's {@link RepoFetchConfig.tokenEnv} for what this maps and why. */
  tokenEnv?: Record<string, string>;
  timezone?: string;
  gif?: GifOptions;
  /**
   * Mask hashes (see mask.ts's `computeMaskHash`) of repos to exclude from
   * the public map entirely — not rendered as a row, not counted in the
   * public summary. Holds hashes, never names: a real name here would leak
   * the moment this file is read. Computing these values requires the salt,
   * so this seeds as an empty array and is filled in out-of-band.
   */
  publicExcludeHashes?: string[];
}

/** "Today" as YYYY-MM-DD in the given IANA time zone. */
function todayInTimeZone(timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which happens to match what we need exactly.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

/**
 * Validate the requested variant. This repository only ever generates the
 * "public" variant — there is no private/unmasked mode here — but a stray
 * `--variant=private` or `ORG_MAP_VARIANT=private` (e.g. copy-pasted from
 * the private repository's own tooling) must fail loudly rather than
 * silently produce something unexpected. CLI flag takes precedence over the
 * env var. Takes `argv`/`env` as parameters (defaulting to the real ones) so
 * it can be exercised directly by test/generate.test.ts.
 */
export function resolveVariant(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): 'public' {
  const cliFlag = argv.find((arg) => arg.startsWith('--variant='));
  const fromCli = cliFlag?.slice('--variant='.length);
  const raw = fromCli ?? env.ORG_MAP_VARIANT ?? 'public';

  if (raw !== 'public') {
    throw new Error(
      `Invalid variant "${raw}". This repository only generates the "public" variant.`
    );
  }
  return raw;
}

/**
 * Resolve MASK_SALT. Fails closed: throws rather than falling back to an
 * unsalted (dictionary-attackable) hash, and is called before any
 * fetching/rendering/writing happens so nothing partial is ever produced
 * when the salt is missing.
 */
export function resolveMaskSalt(env: NodeJS.ProcessEnv = process.env): string {
  const salt = env.MASK_SALT;
  if (!salt || salt.trim() === '') {
    throw new Error(
      'MASK_SALT environment variable is required to generate the org map. ' +
        'Set MASK_SALT before running "npm run generate" (see README.md).'
    );
  }
  // A byte-order mark, newline or stray space silently changes every label
  // and breaks publicExcludeHashes, so an excluded repo would reappear as a
  // masked row. Refuse anything but printable ASCII instead.
  if (!/^[\x21-\x7e]+$/.test(salt)) {
    throw new Error(
      'MASK_SALT contains whitespace, a byte-order mark or a non-printable character. ' +
        'Re-set the MASK_SALT secret with the value only.'
    );
  }
  return salt;
}

/**
 * Filter out repos excluded from the public map (see mask.ts's
 * `isExcludedFromPublicMap`: dot-prefixed names, and `publicExcludeHashes`
 * entries). Applied before grouping and before summary metrics are
 * computed, so excluded repos never appear as rows and are never counted in
 * the public summary — and the summary itself never reveals that anything
 * was excluded, since it only ever sees the filtered list.
 *
 * Exported so it can be exercised directly by test/mask.test.ts without
 * going through network-dependent fetching.
 */
export function filterPublicRepos(
  repos: NormalizedRepo[],
  salt: string,
  excludeHashes: string[]
): NormalizedRepo[] {
  return repos.filter((repo) => {
    const hash = computeMaskHash(`${repo.owner}/${repo.name}`, salt);
    return !isExcludedFromPublicMap(repo.name, hash, excludeHashes);
  });
}

/**
 * Group normalized repos by owner (the account, then each configured org)
 * and convert them to display-safe form.
 *
 * Exported so it can be exercised directly by test/mask.test.ts without
 * going through network-dependent fetching.
 */
export function buildGroups(
  config: Config,
  repos: NormalizedRepo[],
  toDisplaySafe: (repo: NormalizedRepo) => DisplaySafeRepo
): Group[] {
  const groups: Group[] = [];

  const accountRepos = repos.filter(
    (repo) => repo.owner.toLowerCase() === config.account.toLowerCase()
  );
  groups.push({
    login: config.account,
    type: 'account',
    repos: accountRepos.map(toDisplaySafe),
  });

  for (const org of config.orgs ?? []) {
    const orgRepos = repos.filter((repo) => repo.owner.toLowerCase() === org.toLowerCase());
    groups.push({
      login: org,
      type: 'org',
      repos: orgRepos.map(toDisplaySafe),
    });
  }

  return groups;
}

/**
 * Summary metrics: counts of public/private repos, plus a language
 * distribution computed from PUBLIC repositories only. Private repos never
 * contribute to `languages` — their `language` field is always null anyway
 * (see github.ts's `normalizeRepo`), but the `isPrivate` check below is what
 * actually enforces the "public-only" contract, not that upstream nulling.
 *
 * Callers must pass an already-`filterPublicRepos`-filtered list — excluded
 * repos must not contribute to `privateCount`/`publicCount` either, so the
 * exclusion the summary reflects matches the exclusion applied to the rows.
 *
 * Exported so it can be exercised directly by test/mask.test.ts without
 * going through network-dependent fetching.
 */
export function buildPublicSummaryMetrics(repos: NormalizedRepo[]): SummaryMetrics {
  let publicCount = 0;
  let privateCount = 0;
  const languageCounts = new Map<string, number>();

  for (const repo of repos) {
    if (repo.isPrivate) {
      privateCount++;
      continue; // never derive language stats from a private repo
    }
    publicCount++;
    const language = repo.language ?? 'Unknown';
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }

  const languages = [...languageCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([language, count]) => ({ language, count }));

  return { publicCount, privateCount, languages };
}

async function main(): Promise<void> {
  resolveVariant(); // throws if anything other than "public" was requested
  // Resolved (and can throw) before any fetching/writing — fail closed.
  const maskSalt = resolveMaskSalt();

  const config: Config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));

  const repos = await fetchAllRepos(config);

  const filteredRepos = filterPublicRepos(repos, maskSalt, config.publicExcludeHashes ?? []);

  const groups = buildGroups(config, filteredRepos, (repo) => toPublicRepo(repo, maskSalt));
  const date = todayInTimeZone(config.timezone ?? 'UTC');

  // Fail closed on a collision, before anything is rendered/written — see
  // mask.ts's `assertUniqueMaskedLabels`. Only private repos carry a masked
  // label; public repos keep their real name and are not part of this
  // uniqueness contract.
  const maskedLabels = groups.flatMap((group) =>
    group.repos.filter((repo) => repo.isPrivate).map((repo) => repo.name)
  );
  assertUniqueMaskedLabels(maskedLabels);

  // Row position must not leak information, so each group's rows are sorted
  // by the rendered label string rather than kept in fetch order. Plain
  // code-unit comparison (not localeCompare) keeps the order identical
  // across runners regardless of locale/ICU differences.
  for (const group of groups) {
    group.repos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  const summary = buildPublicSummaryMetrics(filteredRepos);

  const svg = buildSvg({
    date,
    account: config.account,
    groups,
    summary,
    // Private repo rows drop the fork/archived suffix and muted style —
    // that status is new information about a private repo the mask itself
    // doesn't carry. Public repo rows are unaffected (see svg.ts's
    // BuildSvgParams doc comment).
    showForkArchivedInfo: false,
  });

  await mkdir(HISTORY_DIR, { recursive: true });
  await writeFile(SVG_PATH, svg, 'utf-8');
  await writeFile(path.join(HISTORY_DIR, `${date}.svg`), svg, 'utf-8');

  // Filenames are YYYY-MM-DD.svg, so a plain lexical sort is chronological.
  const historyFiles = (await readdir(HISTORY_DIR))
    .filter((name) => name.endsWith('.svg'))
    .sort()
    .map((name) => path.join(HISTORY_DIR, name));

  await buildGif(historyFiles, GIF_PATH, config.gif ?? {});

  // Counted from the filtered list, not the raw fetch, so the numbers
  // logged describe what was actually rendered rather than claiming a count
  // the artifact deliberately excludes.
  let publicCount = 0;
  let privateCount = 0;
  for (const repo of filteredRepos) {
    if (repo.isPrivate) privateCount++;
    else publicCount++;
  }

  console.log(
    `[org-map] ${date}: ${publicCount} public / ${privateCount} private repos ` +
      `across 1 account + ${(config.orgs ?? []).length} org(s). ` +
      `History frames: ${historyFiles.length}.`
  );
}

// Only run when this file is executed directly (`tsx scripts/generate.ts`),
// not when it's imported as a module (e.g. by test/mask.test.ts, to reuse
// `buildGroups`/`buildPublicSummaryMetrics`/`filterPublicRepos` without
// triggering a real, network-dependent, credential-requiring run).
const isMainModule =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[org-map] generation failed:', message);
    process.exitCode = 1;
  });
}
