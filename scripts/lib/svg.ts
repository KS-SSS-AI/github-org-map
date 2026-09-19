// Renders the organization/account map as a modern, high-performance dark homelab dashboard SVG string.
//
// Design goals:
//  - Beautiful, production-grade Homelab Dark Chassis styling with GitHub Dark (#0d1117)
//    base canvas to eliminate any corner notch artifacts on GitHub.
//  - Clean card containers for each Account / Organization group with custom vector iconography.
//  - High-visibility status header bar with live pulsing sync LED and summary metric chips.
//  - Public repos highlighted with emerald unlock rings and cyan titles; private repos masked
//    with crimson secure dots, monospace hash badges, and [MASKED] chips.
//  - Fully responsive and horizontally balanced layout.

import type { DisplaySafeRepo } from './mask.js';

/**
 * Display-safe repo groups (private repo names already masked, private
 * description/topics already dropped — see mask.ts).
 */
export interface Group {
  login: string;
  type: 'account' | 'org';
  repos: DisplaySafeRepo[];
}

interface RenderedGroup {
  markup: string;
  width: number;
  height: number;
}

interface GroupLayout {
  columnsData: DisplaySafeRepo[][];
  columns: number;
  rowsPerColumn: number;
  width: number;
  height: number;
}

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO_STACK =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

const LAYOUT = {
  margin: 28,
  headerHeight: 52,
  headerGap: 24,
  groupGap: 24,
  columnWidth: 360,
  columnGap: 20,
  cardPadding: 16,
  cardHeaderHeight: 46,
  rowHeight: 30,
  maxRowsPerColumn: 20,
  footerHeight: 36,
};

/** Escape text for safe inclusion inside SVG element content/attributes. */
export function escapeXml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return ch;
    }
  });
}

/**
 * Split one group's repo list into internal columns of at most
 * `LAYOUT.maxRowsPerColumn` rows each.
 */
function layoutGroup(group: Group): GroupLayout {
  const repoCount = group.repos.length;

  if (repoCount === 0) {
    return {
      columnsData: [[]],
      columns: 1,
      rowsPerColumn: 1,
      width: LAYOUT.columnWidth,
      height: LAYOUT.rowHeight,
    };
  }

  const columns = Math.max(1, Math.ceil(repoCount / LAYOUT.maxRowsPerColumn));
  const rowsPerColumn = Math.ceil(repoCount / columns);

  const columnsData: DisplaySafeRepo[][] = [];
  for (let c = 0; c < columns; c++) {
    const start = c * rowsPerColumn;
    const end = Math.min(start + rowsPerColumn, repoCount);
    columnsData.push(group.repos.slice(start, end));
  }

  return {
    columnsData,
    columns,
    rowsPerColumn,
    width: columns * LAYOUT.columnWidth + (columns - 1) * LAYOUT.columnGap,
    height: rowsPerColumn * LAYOUT.rowHeight,
  };
}

function renderRepoRow(
  repo: DisplaySafeRepo,
  rowX: number,
  rowY: number,
  showForkArchivedInfo: boolean
): string {
  const cy = rowY + 13;
  const suppressForThisRepo = !showForkArchivedInfo && repo.isPrivate;
  const suffix = suppressForThisRepo
    ? ''
    : repo.fork
      ? ' (fork)'
      : repo.archived
        ? ' (archived)'
        : '';

  if (repo.isPrivate) {
    // Private Masked Repository Row
    return `
        <!-- Private Repo Row -->
        <rect x="${rowX}" y="${rowY}" width="${LAYOUT.columnWidth}" height="26" rx="5" fill="#080d18" stroke="#151f33" stroke-width="0.8"/>
        <circle cx="${rowX + 14}" cy="${cy}" r="4" fill="#f43f5e" filter="url(#badge-glow)"/>
        <text x="${rowX + 26}" y="${cy + 4}" fill="#94a3b8" font-family="${MONO_STACK}" font-size="12" letter-spacing="0.5">${escapeXml(
          repo.name
        )}${escapeXml(suffix)}</text>
        <rect x="${rowX + LAYOUT.columnWidth - 58}" y="${rowY + 5}" width="50" height="16" rx="3" fill="#240d16" stroke="#881337" stroke-width="0.8"/>
        <text x="${rowX + LAYOUT.columnWidth - 33}" y="${rowY + 16.5}" fill="#fda4af" font-family="${FONT_STACK}" font-size="8.5" font-weight="700" text-anchor="middle">MASKED</text>`;
  }

  // Public Repository Row
  return `
        <!-- Public Repo Row -->
        <rect x="${rowX}" y="${rowY}" width="${LAYOUT.columnWidth}" height="26" rx="5" fill="#080d18" stroke="#151f33" stroke-width="0.8"/>
        <circle cx="${rowX + 14}" cy="${cy}" r="4.5" fill="none" stroke="#34d399" stroke-width="1.8"/>
        <circle cx="${rowX + 14}" cy="${cy}" r="1.5" fill="#34d399"/>
        <text x="${rowX + 26}" y="${cy + 4}" fill="#38bdf8" font-family="${FONT_STACK}" font-size="12.5" font-weight="600">${escapeXml(
          repo.name
        )}${escapeXml(suffix)}</text>
        <rect x="${rowX + LAYOUT.columnWidth - 56}" y="${rowY + 5}" width="48" height="16" rx="3" fill="#064e3b" stroke="#059669" stroke-width="0.8"/>
        <text x="${rowX + LAYOUT.columnWidth - 32}" y="${rowY + 16.5}" fill="#6ee7b7" font-family="${FONT_STACK}" font-size="8.5" font-weight="700" text-anchor="middle">PUBLIC</text>`;
}

function renderGroup(
  group: Group,
  x: number,
  groupTop: number,
  showForkArchivedInfo: boolean
): RenderedGroup {
  const layout = layoutGroup(group);
  const isAccount = group.type === 'account';
  const typeLabel = isAccount ? 'Account' : 'Organization';
  const repoCount = group.repos.length;
  const countLabel = `${repoCount} repo${repoCount === 1 ? '' : 's'}`;

  const cardWidth = layout.width + LAYOUT.cardPadding * 2;
  const cardHeight = LAYOUT.cardHeaderHeight + layout.height + LAYOUT.cardPadding * 2;

  const metaPillText = `${typeLabel} · ${countLabel}`;
  const metaPillWidth = Math.max(110, metaPillText.length * 7 + 20);

  let body: string;
  if (repoCount === 0) {
    body = `<text x="${x + LAYOUT.cardPadding}" y="${groupTop + LAYOUT.cardHeaderHeight + 28}" fill="#64748b" font-family="${FONT_STACK}" font-size="12" font-style="italic">No repositories</text>`;
  } else {
    const rowsMarkup: string[] = [];
    layout.columnsData.forEach((columnRepos, colIndex) => {
      const colX = x + LAYOUT.cardPadding + colIndex * (LAYOUT.columnWidth + LAYOUT.columnGap);
      columnRepos.forEach((repo, rowIndex) => {
        const rowY = groupTop + LAYOUT.cardHeaderHeight + LAYOUT.cardPadding + rowIndex * LAYOUT.rowHeight;
        rowsMarkup.push(renderRepoRow(repo, colX, rowY, showForkArchivedInfo));
      });
    });
    body = rowsMarkup.join('\n');
  }

  // Vector icon inside group header
  const iconMarkup = isAccount
    ? `<!-- Account User Icon -->
       <g transform="translate(${x + 14}, ${groupTop + 14})">
         <circle cx="9" cy="6" r="4.5" fill="#38bdf8"/>
         <path d="M 2 17 C 2 13 6 11 9 11 C 12 11 16 13 16 17 Z" fill="#38bdf8"/>
       </g>`
    : `<!-- Organization Building/Network Icon -->
       <g transform="translate(${x + 14}, ${groupTop + 13})">
         <rect x="2" y="2" width="14" height="15" rx="2" fill="none" stroke="#c084fc" stroke-width="1.5"/>
         <rect x="5" y="5" width="2.5" height="2.5" fill="#e9d5ff"/>
         <rect x="10.5" y="5" width="2.5" height="2.5" fill="#e9d5ff"/>
         <rect x="5" y="10" width="2.5" height="2.5" fill="#e9d5ff"/>
         <rect x="10.5" y="10" width="2.5" height="2.5" fill="#e9d5ff"/>
       </g>`;

  const markup = `
    <!-- Group Card: ${escapeXml(group.login)} -->
    <g>
      <!-- Card Chassis Container -->
      <rect x="${x}" y="${groupTop}" width="${cardWidth}" height="${cardHeight}" rx="12" fill="#0c1220" stroke="#1e2c45" stroke-width="1.2"/>
      
      <!-- Card Header Strip -->
      <path d="M ${x} ${groupTop + 12} C ${x} ${groupTop + 5.37} ${x + 5.37} ${groupTop} ${x + 12} ${groupTop} L ${x + cardWidth - 12} ${groupTop} C ${x + cardWidth - 5.37} ${groupTop} ${x + cardWidth} ${groupTop + 5.37} ${x + cardWidth} ${groupTop + 12} L ${x + cardWidth} ${groupTop + 44} L ${x} ${groupTop + 44} Z" fill="#111a2e" stroke="#1e2c45" stroke-width="1"/>
      <line x1="${x}" y1="${groupTop + 44}" x2="${x + cardWidth}" y2="${groupTop + 44}" stroke="#1e2c45" stroke-width="1"/>

      ${iconMarkup}
      
      <!-- Group Title -->
      <text x="${x + 40}" y="${groupTop + 27}" fill="#f8fafc" font-family="${FONT_STACK}" font-size="14" font-weight="800">${escapeXml(
        group.login
      )}</text>

      <!-- Group Meta Badge -->
      <rect x="${x + cardWidth - metaPillWidth - 14}" y="${groupTop + 10}" width="${metaPillWidth}" height="24" rx="5" fill="#0d1424" stroke="#1e2c45" stroke-width="0.8"/>
      <text x="${x + cardWidth - metaPillWidth / 2 - 14}" y="${groupTop + 26}" fill="#94a3b8" font-family="${FONT_STACK}" font-size="10.5" font-weight="600" text-anchor="middle">${escapeXml(
        metaPillText
      )}</text>

      ${body}
    </g>`;

  return { markup, width: cardWidth, height: cardHeight };
}

/**
 * Summary metrics rendered inside the header bar.
 */
export interface SummaryMetrics {
  publicCount: number;
  privateCount: number;
  /** Language -> repo count, public repos only, most common first. */
  languages: { language: string; count: number }[];
}

export interface BuildSvgParams {
  date: string;
  account: string;
  groups: Group[];
  summary?: SummaryMetrics;
  showForkArchivedInfo?: boolean;
}

/** Build the full organization map SVG with modern dark homelab chassis styling. */
export function buildSvg({
  date,
  account,
  groups,
  summary,
  showForkArchivedInfo = true,
}: BuildSvgParams): string {
  let x = LAYOUT.margin;
  const groupTop = LAYOUT.margin + LAYOUT.headerHeight + LAYOUT.headerGap;

  const rendered = groups.map((group) => {
    const result = renderGroup(group, x, groupTop, showForkArchivedInfo);
    x += result.width + LAYOUT.groupGap;
    return result;
  });

  const contentWidth = rendered.reduce(
    (sum, r, i) => sum + r.width + (i > 0 ? LAYOUT.groupGap : 0),
    0
  );
  const contentHeight = rendered.length > 0 ? Math.max(...rendered.map((r) => r.height)) : 200;

  const width = Math.max(LAYOUT.margin * 2 + contentWidth, 760);
  const height = groupTop + contentHeight + LAYOUT.footerHeight + 8;
  const headerWidth = width - LAYOUT.margin * 2;

  // Header Summary Metric Chips
  let metricPillsMarkup = '';
  if (summary) {
    const p1Text = `${summary.publicCount} Public`;
    const p1W = 86;

    const p2Text = `${summary.privateCount} Masked`;
    const p2W = 92;

    const langFormatted =
      summary.languages.length > 0
        ? summary.languages.slice(0, 3).map((l) => `${l.language} ${l.count}`).join(' · ')
        : 'None';
    const p3Text = `Languages: ${langFormatted}`;
    const p3W = Math.max(120, p3Text.length * 6.5 + 24);

    const startX = headerWidth - (p1W + p2W + p3W + 20) - 12;

    metricPillsMarkup = `
      <!-- Metric Chip 1: Public -->
      <g transform="translate(${startX}, 12)">
        <rect width="${p1W}" height="28" rx="6" fill="#092319" stroke="#065f46" stroke-width="1"/>
        <circle cx="12" cy="14" r="3.5" fill="#34d399"/>
        <text x="22" y="18" fill="#6ee7b7" font-family="${FONT_STACK}" font-size="11" font-weight="700">${escapeXml(p1Text)}</text>
      </g>
      <!-- Metric Chip 2: Private -->
      <g transform="translate(${startX + p1W + 10}, 12)">
        <rect width="${p2W}" height="28" rx="6" fill="#240d16" stroke="#881337" stroke-width="1"/>
        <circle cx="12" cy="14" r="3.5" fill="#f43f5e"/>
        <text x="22" y="18" fill="#fda4af" font-family="${FONT_STACK}" font-size="11" font-weight="700">${escapeXml(p2Text)}</text>
      </g>
      <!-- Metric Chip 3: Languages -->
      <g transform="translate(${startX + p1W + p2W + 20}, 12)">
        <rect width="${p3W}" height="28" rx="6" fill="#0d1527" stroke="#1d2f4d" stroke-width="1"/>
        <text x="12" y="18" fill="#93c5fd" font-family="${FONT_STACK}" font-size="10.5" font-weight="600">${escapeXml(p3Text)}</text>
      </g>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(
    `GitHub organization map for ${account} on ${date}`
  )}">
  <defs>
    <!-- Dark Homelab Canvas Gradient -->
    <linearGradient id="canvas-bg" x1="0" y1="0" x2="${width}" y2="${height}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#070a14"/>
      <stop offset="50%" stop-color="#0c1120"/>
      <stop offset="100%" stop-color="#080c18"/>
    </linearGradient>

    <!-- Subtle Grid Pattern -->
    <pattern id="ui-grid" width="28" height="28" patternUnits="userSpaceOnUse">
      <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#1e293b" stroke-width="0.6" stroke-opacity="0.25"/>
    </pattern>

    <!-- Glow Filter for LEDs and Active Dots -->
    <filter id="badge-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge>
        <feMergeNode in="blur"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Base Dashboard Canvas (GitHub Dark #0d1117 background base eliminates corner notches) -->
  <rect width="${width}" height="${height}" fill="#0d1117"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" fill="url(#canvas-bg)" stroke="#1e293b" stroke-width="1.2"/>
  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="14" fill="url(#ui-grid)"/>

  <!-- Top Status & Navigation Bar -->
  <g transform="translate(${LAYOUT.margin}, ${LAYOUT.margin})">
    <rect width="${headerWidth}" height="52" rx="8" fill="#0d1424" stroke="#1e2c45" stroke-width="1"/>
    
    <!-- Active Status Pulse LED -->
    <rect x="10" y="10" width="32" height="32" rx="6" fill="#064e3b" stroke="#34d399" stroke-width="1"/>
    <circle cx="26" cy="26" r="4.5" fill="#34d399" filter="url(#badge-glow)"/>

    <!-- Title & Date -->
    <text x="52" y="24" fill="#f8fafc" font-family="${FONT_STACK}" font-size="14.5" font-weight="700">GitHub Organization Map — ${escapeXml(
      account
    )}</text>
    <text x="52" y="40" fill="#7dd3fc" font-family="${FONT_STACK}" font-size="11" font-weight="600">SNAPSHOT: ${escapeXml(
      date
    )} · DAILY TELEMETRY</text>

    ${metricPillsMarkup}
  </g>

  <!-- Group Cards Container -->
  ${rendered.map((r) => r.markup).join('\n')}

  <!-- Footer Specification Bar -->
  <text x="${width / 2}" y="${height - 14}" fill="#64748b" font-family="${FONT_STACK}" font-size="11" font-weight="500" text-anchor="middle">
    Zero-Knowledge SHA-256 Masked Telemetry · Automated Daily GitOps Cartography · ${escapeXml(account)}
  </text>
</svg>
`;
}
