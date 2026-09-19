// GitHub REST v3 client for fetching the repositories owned by an account
// and its organizations.
//
// A fine-grained personal access token has exactly one resource owner, so
// one token cannot read both a user's own repositories and an
// organization's repositories. Each owner therefore resolves its own token:
// `RepoFetchConfig.tokenEnv` maps an owner login to the name of the
// environment variable holding that owner's token, and `resolveToken` reads
// exactly that variable when given one. An owner with no `tokenEnv` entry
// falls back to the original single-token behavior: process.env.ORG_READ_TOKEN,
// then process.env.GITHUB_TOKEN.
//
// Uses the global `fetch` (available in Node >=18). No network calls are
// made when this module is merely imported; every exported function
// performs its own request(s) on demand.

import dns from 'node:dns';
dns.setDefaultResultOrder?.('ipv4first');

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'github-org-map-generator/1.0 (+https://github.com)';
const API_VERSION = '2022-11-28';

/** Subset of the GitHub REST v3 repo object fields this project reads. */
export interface RawGitHubRepo {
  owner?: { login?: string | null } | null;
  name: string;
  visibility?: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  language?: string | null;
  stargazers_count?: number;
  updated_at?: string | null;
  description?: string | null;
  topics?: string[];
}

interface NormalizedRepoBase {
  owner: string;
  name: string;
  visibility: string;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stargazers: number;
  updatedAt: string | null;
}

/** A normalized public repo: description/topics are always present. */
export interface PublicNormalizedRepo extends NormalizedRepoBase {
  isPrivate: false;
  description: string | null;
  topics: string[];
}

/**
 * A normalized private repo: description/topics/language are never present
 * (or, for language, always null) — see `normalizeRepo` below for why.
 */
export interface PrivateNormalizedRepo extends NormalizedRepoBase {
  isPrivate: true;
}

export type NormalizedRepo = PublicNormalizedRepo | PrivateNormalizedRepo;

/**
 * Resolve the API token to use.
 *
 * With `envName`, reads *only* that environment variable — no fallback to
 * `ORG_READ_TOKEN`/`GITHUB_TOKEN`, since a silent fallback would quietly
 * read the wrong owner's repos (or none) under the requesting owner's name
 * instead of failing loudly. Without `envName`, keeps the original
 * documented fallback order: `ORG_READ_TOKEN`, then `GITHUB_TOKEN`.
 *
 * Throws a clear, actionable error naming the variable consulted when it is
 * unset, since a silent anonymous fallback would just fail later with a
 * confusing 401/403.
 */
export function resolveToken(envName?: string): string {
  const rawToken = envName !== undefined
    ? process.env[envName]
    : process.env.ORG_READ_TOKEN || process.env.GITHUB_TOKEN;

  if (!rawToken) {
    throw new Error(
      envName !== undefined
        ? `No GitHub token found. Set the ${envName} environment variable ` +
          '(a token with read-only access to this owner) before running this script.'
        : 'No GitHub token found. Set the ORG_READ_TOKEN environment variable ' +
          '(a token with read-only access to the account and its organizations), ' +
          'or GITHUB_TOKEN as a fallback, before running this script.'
    );
  }

  // A secret stored through a shell that emits a UTF-8 BOM, or that keeps the
  // trailing newline a pipe adds, arrives with characters that are not valid
  // in an HTTP header value. `fetch` then fails with an opaque "Cannot convert
  // argument to a ByteString because the character at index N has a value of
  // 65279" instead of a plain 401, so strip the BOM and surrounding
  // whitespace before the token is ever put in a header.
  const token = rawToken.replace(/^﻿+/, '').replace(/﻿+$/, '').trim();

  if (!token) {
    throw new Error(
      envName !== undefined
        ? `The ${envName} token is empty after stripping whitespace and byte-order marks. ` +
          `Re-set the ${envName} secret with the token value only.`
        : 'The GitHub token is empty after stripping whitespace and byte-order marks. ' +
          'Re-set the ORG_READ_TOKEN secret with the token value only.'
    );
  }

  // Anything still outside the printable ASCII range cannot go into a header,
  // and reporting the offending position beats letting fetch throw about a
  // ByteString conversion the caller cannot act on. The token value itself is
  // never included in the message.
  const badCharIndex = [...token].findIndex((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x21 || code > 0x7e;
  });
  if (badCharIndex !== -1) {
    const varName = envName ?? 'ORG_READ_TOKEN';
    throw new Error(
      `The GitHub token contains a character at index ${badCharIndex} that is not valid ` +
        `in an HTTP header (expected printable ASCII). Re-set the ${varName} secret, ` +
        'making sure no byte-order mark, newline or stray character is included.'
    );
  }

  return token;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
}

function buildUrl(path: string, params: Record<string, string | number | undefined | null> = {}): string {
  const url = new URL(path, API_BASE);
  url.searchParams.set('per_page', '100');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Extract the `rel="next"` URL from a GitHub Link header, or null. */
function getNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match && match[2] === 'next') {
      return match[1];
    }
  }
  return null;
}

/**
 * GET a paginated list endpoint, following `Link: rel="next"` headers until
 * exhausted, and return the concatenated array of results.
 */
async function githubGetPaginated(initialUrl: string, token: string): Promise<RawGitHubRepo[]> {
  const results: RawGitHubRepo[] = [];
  let url: string | null = initialUrl;

  while (url) {
    const res: Response = await fetch(url, { headers: authHeaders(token) });

    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const resetHeader = res.headers.get('x-ratelimit-reset');
        const resetAt = resetHeader
          ? new Date(Number(resetHeader) * 1000).toISOString()
          : 'unknown time';
        throw new Error(
          `GitHub API rate limit exceeded while requesting ${url}. Limit resets at ${resetAt}.`
        );
      }
      // Status and request path only — never the response body, which could
      // echo back request details or other data not meant to be logged.
      throw new Error(`GitHub API request to ${url} was forbidden (403).`);
    }

    if (!res.ok) {
      throw new Error(`GitHub API request to ${url} failed with status ${res.status}.`);
    }

    const page: unknown = await res.json();
    if (!Array.isArray(page)) {
      throw new Error(`Expected an array response from ${url}, got ${typeof page}.`);
    }
    results.push(...(page as RawGitHubRepo[]));

    url = getNextLink(res.headers.get('link'));
  }

  return results;
}

/**
 * Fetch the authenticated user's login, or null if it cannot be determined
 * (e.g. the token lacks the scope for /user, or is an org/app token). This
 * is a best-effort lookup, not a hard requirement, so failures are swallowed
 * rather than thrown.
 */
async function fetchAuthenticatedLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch(buildUrl('/user'), { headers: authHeaders(token) });
    if (!res.ok) return null;
    const data = (await res.json()) as { login?: unknown };
    return typeof data.login === 'string' ? data.login : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a raw GitHub API repo object into the shape this project works
 * with internally. Private repos never carry `description` or `topics` past
 * this point, and their `language` is dropped too (a language tag combined
 * with stars/updatedAt can narrow down which private repo it is, which is
 * more than the masking contract intends to reveal).
 */
function normalizeRepo(raw: RawGitHubRepo): NormalizedRepo {
  const isPrivate = raw.private === true || raw.visibility === 'private';

  const base: NormalizedRepoBase = {
    owner: raw.owner?.login ?? '',
    name: raw.name,
    visibility: raw.visibility ?? (isPrivate ? 'private' : 'public'),
    fork: Boolean(raw.fork),
    archived: Boolean(raw.archived),
    language: isPrivate ? null : raw.language ?? null,
    stargazers: raw.stargazers_count ?? 0,
    updatedAt: raw.updated_at ?? null,
  };

  if (!isPrivate) {
    return {
      ...base,
      isPrivate: false,
      description: raw.description ?? null,
      topics: Array.isArray(raw.topics) ? raw.topics : [],
    };
  }

  return {
    ...base,
    isPrivate: true,
  };
}

/**
 * Fetch repositories owned directly by the configured account.
 *
 * `/users/{account}/repos` only ever returns public repos, even when called
 * with a valid token, so when the token belongs to that same account we
 * additionally call `/user/repos?visibility=all&affiliation=owner` to pick
 * up private repos too.
 */
export async function fetchAccountRepos(account: string, token: string): Promise<NormalizedRepo[]> {
  const raw: RawGitHubRepo[] = [];

  const publicRepos = await githubGetPaginated(
    buildUrl(`/users/${encodeURIComponent(account)}/repos`, { type: 'owner' }),
    token
  );
  raw.push(...publicRepos);

  const authenticatedLogin = await fetchAuthenticatedLogin(token);
  if (authenticatedLogin && authenticatedLogin.toLowerCase() === account.toLowerCase()) {
    const ownRepos = await githubGetPaginated(
      buildUrl('/user/repos', { visibility: 'all', affiliation: 'owner' }),
      token
    );
    raw.push(...ownRepos);
  }

  return raw.map(normalizeRepo);
}

/** Fetch all repositories (public and private) visible to the token for an org. */
export async function fetchOrgRepos(org: string, token: string): Promise<NormalizedRepo[]> {
  const raw = await githubGetPaginated(
    buildUrl(`/orgs/${encodeURIComponent(org)}/repos`, { type: 'all' }),
    token
  );
  return raw.map(normalizeRepo);
}

/** Minimal shape {@link fetchAllRepos} needs from the full config object. */
export interface RepoFetchConfig {
  account: string;
  orgs?: string[];
  /**
   * Maps an owner login (account or org name) to the environment variable
   * name holding that owner's token. Lookup is case-insensitive, since
   * GitHub logins are. An owner with no matching entry falls back to
   * {@link resolveToken}'s default `ORG_READ_TOKEN`/`GITHUB_TOKEN` behavior.
   */
  tokenEnv?: Record<string, string>;
}

/** Case-insensitive lookup of `owner` in `tokenEnv`, resolving and caching the token by env var name. */
function resolveTokenForOwner(
  owner: string,
  tokenEnv: Record<string, string> | undefined,
  cache: Map<string, string>
): string {
  const envName = tokenEnv
    ? Object.entries(tokenEnv).find(([login]) => login.toLowerCase() === owner.toLowerCase())?.[1]
    : undefined;

  // Cache by env var name (not by owner) so two owners mapped to the same
  // variable, or the shared no-mapping fallback, only resolve/validate once.
  const cacheKey = envName ?? '\0default';
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const token = resolveToken(envName);
  cache.set(cacheKey, token);
  return token;
}

/**
 * Fetch and deduplicate (by "owner/name") all repos for the configured
 * account plus every configured org. Each owner's token is resolved
 * independently via {@link resolveTokenForOwner} (see this file's top
 * comment for why one token cannot cover both the account and its orgs).
 */
export async function fetchAllRepos(config: RepoFetchConfig): Promise<NormalizedRepo[]> {
  const tokenCache = new Map<string, string>();
  const seen = new Map<string, NormalizedRepo>();

  const accountToken = resolveTokenForOwner(config.account, config.tokenEnv, tokenCache);
  const accountRepos = await fetchAccountRepos(config.account, accountToken);
  for (const repo of accountRepos) {
    seen.set(`${repo.owner}/${repo.name}`, repo);
  }

  for (const org of config.orgs ?? []) {
    const orgToken = resolveTokenForOwner(org, config.tokenEnv, tokenCache);
    const orgRepos = await fetchOrgRepos(org, orgToken);
    for (const repo of orgRepos) {
      seen.set(`${repo.owner}/${repo.name}`, repo);
    }
  }

  return [...seen.values()];
}
