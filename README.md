<div align="center">

<p>
  <img src="docs/assets/locales/en/banner.svg" alt="GitHub Organization Map &amp; Cartography" width="100%" />
</p>

# github-org-map

<p>
  <strong>Automated daily cartography and topology mapping of KS-SSS-AI repositories with zero-knowledge SHA-256 privacy masking.</strong>
</p>

<p>
  <strong>🇺🇸 English</strong> ·
  <a href="./docs/locales/ko.md">🇰🇷 한국어</a> ·
  <a href="./docs/locales/zh-CN.md">🇨🇳 中文</a> ·
  <a href="./docs/locales/es.md">🇪🇸 Español</a> ·
  <a href="./docs/locales/hi.md">🇮🇳 हिन्दी</a><br />
  <a href="./docs/locales/ar.md">🇸🇦 العربية</a> ·
  <a href="./docs/locales/pt-BR.md">🇧🇷 Português</a> ·
  <a href="./docs/locales/ru.md">🇷🇺 Русский</a> ·
  <a href="./docs/locales/fr.md">🇫🇷 Français</a> ·
  <a href="./docs/locales/id.md">🇮🇩 Bahasa Indonesia</a>
</p>

<p>
  <a href="https://github.com/KS-SSS-AI/github-org-map/releases"><img src="https://img.shields.io/badge/Release-v1.0.0-A78BFA?style=flat-square&logo=github&labelColor=161126" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square&labelColor=161126" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.0+-3178C6.svg?style=flat-square&logo=typescript&logoColor=white&labelColor=161126" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Privacy-Zero--Knowledge%20SHA--256-F43F5E.svg?style=flat-square&labelColor=161126" alt="Privacy: SHA-256" />
  <img src="https://img.shields.io/badge/Refresh-Automated%20Daily%20Cron-10B981.svg?style=flat-square&labelColor=161126" alt="Daily Automation" />
</p>

<p align="center">
  <img src="docs/assets/locales/en/org-map.svg" alt="Organization map of the KS-SSS-AI account and the KS-SSS-AI organization, with private repositories shown as masked labels." width="100%" />
</p>

</div>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">About</h2></summary>

A daily-refreshed map of the repositories owned by the KS-SSS-AI account and the KS-SSS-AI organization. Public repositories appear with their real names; private repositories appear only as masked labels, and some are omitted entirely. Each day's snapshot is kept in `history/` and combined into an animated GIF.

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">How it works</h2></summary>

This repository generates the map itself: an SVG snapshot for "today", a
dated history of past snapshots, and a GIF assembled from that history so you
can see how the account/org map has changed over time.

Every repository whose visibility is private has its name replaced with a
masked label; public repos are shown with their real names, since that
information is already public on GitHub. Some repositories are omitted from
the map entirely. `org-map.svg`, `org-map.gif`, and `history/<date>.svg` are
committed to this repository's own root by the workflow below.

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">Required secrets</h2></summary>

A fine-grained personal access token has exactly one resource owner, so one
token cannot read both the account's own repositories and an organization's
repositories. The workflow needs three repository secrets:

- `USER_READ_TOKEN`: a fine-grained token with resource owner set to the
  tracked account, **All repositories** access, and **Metadata** read-only
  permission — enough to list the account's own repositories, including
  private ones.
- `ORG_READ_TOKEN`: a fine-grained token with resource owner set to the
  tracked organization, the same **All repositories** access and
  **Metadata** read-only permission — enough to list the org's repositories.
- `MASK_SALT`: a private random string used to salt the masking hash.
  Required; generation fails closed (throws, writes nothing) if it is
  missing.

Both GitHub tokens are passed to the generator only via the environment,
never on the command line.

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">Schedule</h2></summary>

`.github/workflows/refresh.yml` runs on a daily schedule and on demand via
`workflow_dispatch`. The workflow is split into two jobs so the credentials
that read GitHub and the credential that pushes to this repository are never
held by the same job:

- **`generate`** (`contents: read`, holds `USER_READ_TOKEN`, `ORG_READ_TOKEN`,
  `MASK_SALT`): fetches the current repo list, runs the tests, renders
  today's SVG, appends it to `history/`, rebuilds `org-map.gif`, and uploads
  the result as a workflow artifact. It never has push access to this
  repository.
- **`commit`** (`contents: write`, no secrets): downloads that artifact and
  commits/pushes it if anything changed. It never sees any of the secrets
  above.

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">Running locally</h2></summary>

```sh
npm install
USER_READ_TOKEN=ghp_xxx ORG_READ_TOKEN=ghp_yyy MASK_SALT=<the salt> npm run generate
```

This writes/updates `org-map.svg`, `org-map.gif`, and `history/<date>.svg` in
place. Rerunning it on the same day overwrites that day's history entry
rather than adding a duplicate.

The generator is written in TypeScript and run directly via
[`tsx`](https://github.com/privatenumber/tsx) — no separate build step is
needed. `npm run typecheck` runs `tsc --noEmit` to type-check the project
without emitting anything.

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">Configuration</h2></summary>

Edit `data/config.json` to change the tracked account, organizations,
timezone, or GIF timing (`frameMs`, `lastFrameMs`, `maxFrames`).

`tokenEnv` maps an owner login (the account, or an org name) to the name of
the environment variable holding that owner's token, since one fine-grained
token cannot cover both the account and an org. An owner with no entry here
falls back to `ORG_READ_TOKEN`, then `GITHUB_TOKEN`.

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">Tests</h2></summary>

```sh
npm test
```

</details>

---

<details>
<summary><h2 style="display:inline-block; margin:0;">📬 Contact</h2></summary>

For public work, feedback, or a closer look at the implementation, these are the clearest starting points.

[GitHub profile](https://github.com/KS-SSS-AI) · [Public repositories](https://github.com/KS-SSS-AI?tab=repositories) · [Open an issue](https://github.com/KS-SSS-AI/github-org-map/issues/new) · [Profile source](https://github.com/KS-SSS-AI/KS-SSS-AI)

</details>
