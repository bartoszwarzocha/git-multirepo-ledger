/**
 * The activity report, as a panel in the editor.
 *
 * Same shape as the sibling project's detail panel, because it answers the same
 * kind of question and a reader should not have to learn two layouts: a heading,
 * a row of figure cards, then sections separated by rules, each with a table.
 *
 * A webview panel rather than a markdown document, which is what this was
 * first: markdown could be saved and pasted, but it arrives as a wall of pipe
 * characters that the reader has to render in their head, and a report nobody
 * can take in at a glance is a report that does not get read. Everything the
 * document could do that this cannot - saving, diffing against last week - is
 * one Copy away, so the button is here too.
 *
 * The page decides nothing. Every count, every ordering and every sentence
 * comes from `report/activityReport.ts`, which imports no `vscode`.
 */

import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

import type { ActivityReport, ReportBar } from '../report/activityReport.ts';
import { escapeHtml } from './listPanel.ts';

export class ReportPanel {
  private static current: vscode.WebviewPanel | undefined;

  /**
   * Show the report, reusing the panel if one is already open.
   *
   * One panel, not one per press: a reader who runs the report three times in a
   * minute wants the newest answer, not three tabs of increasingly stale ones.
   */
  static show(report: ActivityReport, markdown: string): void {
    const panel =
      ReportPanel.current ??
      vscode.window.createWebviewPanel(
        'repoLedger.report',
        'Repo Ledger — activity',
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true },
      );

    if (!ReportPanel.current) {
      ReportPanel.current = panel;
      panel.onDidDispose(() => {
        ReportPanel.current = undefined;
      });
      panel.webview.onDidReceiveMessage((message: unknown) => {
        if ((message as { type?: unknown } | null)?.type === 'copy') {
          void vscode.env.clipboard.writeText(markdown).then(() => {
            void vscode.window.showInformationMessage('The report was copied as Markdown.');
          });
        }
      });
    }

    panel.title = `Repo Ledger — ${report.periodLabel}`;
    panel.webview.html = renderReportHtml(report, createNonce());
    panel.reveal(panel.viewColumn, false);
  }

  static dispose(): void {
    ReportPanel.current?.dispose();
    ReportPanel.current = undefined;
  }
}

function createNonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * The commits-per-day bars.
 *
 * Drawn rather than tabulated because the shape of a week is the one thing a
 * table of the same numbers does not show: a reader sees three quiet days and a
 * Thursday without reading a single figure. The scale is stated on the tallest
 * bar so the height is never the only thing carrying the number.
 */
function renderBars(bars: readonly ReportBar[]): string {
  if (bars.length === 0) {
    return '';
  }
  const tallest = Math.max(...bars.map((bar) => bar.commits), 1);
  const columns = bars
    .map((bar) => {
      const height = Math.max(2, Math.round((bar.commits / tallest) * 100));
      const label = `${bar.heading}: ${bar.commits} commit${bar.commits === 1 ? '' : 's'} in ${bar.repositories} repositor${bar.repositories === 1 ? 'y' : 'ies'}`;
      return (
        `<div class="bar" title="${escapeHtml(label)}">` +
        `<span class="bar-count">${bar.commits}</span>` +
        `<span class="bar-fill" style="height:${height}%"></span>` +
        `<span class="bar-label">${escapeHtml(bar.short)}</span></div>`
      );
    })
    .join('');
  return `<div class="bars" role="img" aria-label="Commits per day">${columns}</div>`;
}

function renderCards(report: ActivityReport): string {
  const card = (label: string, value: string, note?: string): string =>
    `<div class="card"><span class="card-label">${escapeHtml(label)}</span>` +
    `<span class="card-value">${escapeHtml(value)}</span>` +
    `${note ? `<span class="card-note">${escapeHtml(note)}</span>` : ''}</div>`;

  return (
    `<div class="cards">` +
    card('Commits', String(report.commits)) +
    card('Repositories', String(report.repositories.length), `of ${report.discovered} found`) +
    card('Authors', String(report.authors.length)) +
    card('Merges', String(report.merges)) +
    `</div>`
  );
}

export function renderReportHtml(report: ActivityReport, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  const unreadable =
    report.failures.length > 0
      ? `<section class="unreadable"><h2>Not counted anywhere above</h2>
<p class="lede">${escapeHtml(report.failureLede)}</p>
<div class="table-scroll"><table><thead><tr><th>Repository</th><th>What git said</th></tr></thead><tbody>` +
        report.failures
          .map(
            (failure) =>
              `<tr><td>${escapeHtml(failure.label)}</td>` +
              `<td class="reason">${escapeHtml(failure.reason)}</td></tr>`,
          )
          .join('') +
        `</tbody></table></div></section>`
      : '';

  const repositories =
    report.repositories.length > 0
      ? `<section><h2>Where the work went</h2>
<div class="table-scroll"><table><thead><tr><th>Repository</th><th class="num">Commits</th><th class="num">Merges</th><th class="num">Authors</th><th>Last commit</th></tr></thead><tbody>` +
        report.repositories
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.label)}</td>` +
              `<td class="num">${row.commits}</td>` +
              `<td class="num">${row.merges}</td>` +
              `<td class="num">${row.authors}</td>` +
              `<td class="muted">${escapeHtml(row.last)}</td></tr>`,
          )
          .join('') +
        `</tbody></table></div></section>`
      : '';

  const authors =
    report.authors.length > 0
      ? `<section><h2>Who did it</h2>
<div class="table-scroll"><table><thead><tr><th>Author</th><th class="num">Commits</th><th class="num">Merges</th><th class="num">Repositories</th><th>Last commit</th></tr></thead><tbody>` +
        report.authors
          .map(
            (row) =>
              `<tr><td>${escapeHtml(row.author)}</td>` +
              `<td class="num">${row.commits}</td>` +
              `<td class="num">${row.merges}</td>` +
              `<td class="num">${row.repositories}</td>` +
              `<td class="muted">${escapeHtml(row.last)}</td></tr>`,
          )
          .join('') +
        `</tbody></table></div></section>`
      : '';

  const days =
    report.days.length > 0
      ? `<section><h2>Every commit</h2>` +
        report.days
          .map(
            (day) =>
              `<h3>${escapeHtml(day.heading)} <span class="badge">${day.entries.length}</span></h3>
<div class="table-scroll"><table><tbody>` +
              day.entries
                .map(
                  (entry) =>
                    `<tr class="${entry.merge ? 'is-merge' : ''}">` +
                    `<td class="time">${escapeHtml(entry.time)}</td>` +
                    `<td class="repo">${escapeHtml(entry.label)}</td>` +
                    `<td class="subject">${escapeHtml(entry.subject)}` +
                    `${entry.merge ? ' <span class="merge-tag">merge</span>' : ''}</td>` +
                    `<td class="muted">${escapeHtml(entry.author)}</td>` +
                    `<td class="sha">${escapeHtml(entry.shortSha)}</td></tr>`,
                )
                .join('') +
              `</tbody></table></div>`,
          )
          .join('') +
        `</section>`
      : '';

  const empty =
    report.commits === 0
      ? `<p class="empty">${escapeHtml(report.summary)}</p>`
      : `<p class="lede">${escapeHtml(report.summary)}</p>${renderCards(report)}${renderBars(report.bars)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Repo Ledger activity</title>
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<header>
<h1>Activity ${escapeHtml(report.windowPhrase)}</h1>
<p class="subtitle">${escapeHtml(report.generatedFor)} &middot; every figure below comes from a <code>git log</code> that returned; nothing is estimated.</p>
<button type="button" class="copy" data-copy="1">Copy as Markdown</button>
</header>
${empty}
${repositories}
${authors}
${days}
${unreadable}
<script nonce="${nonce}">
const api = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('button[data-copy]')) {
    api.postMessage({ type: 'copy' });
  }
});
</script>
</body>
</html>`;
}

const STYLES = `
:root { color-scheme: light dark; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  margin: 0;
  padding: 0 20px 40px;
  line-height: 1.5;
}
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; }
h1 { flex: 1 1 auto; font-size: 1.5em; font-weight: 600; margin: 20px 0 2px; }
h2 { font-size: 1.1em; font-weight: 600; margin: 0 0 8px; }
h3 { display: flex; align-items: baseline; gap: 8px; font-size: 1em; font-weight: 600; margin: 20px 0 4px; }
p { margin: 6px 0; }
section { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
.subtitle { flex: 1 1 100%; margin: 0 0 12px; color: var(--vscode-descriptionForeground); }
.muted, .lede, .empty { color: var(--vscode-descriptionForeground); }
.lede, .empty { max-width: 78ch; }
.copy {
  padding: 3px 12px; border: none; border-radius: 2px; cursor: pointer;
  font-family: inherit; font-size: 0.9em;
  color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
  background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
}
.copy:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
.copy:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.cards { display: flex; flex-wrap: wrap; gap: 10px; margin: 12px 0 4px; }
.card {
  display: flex; flex-direction: column; gap: 1px; min-width: 130px; padding: 8px 12px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 4px;
}
.card-label { font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); }
.card-value { font-size: 1.5em; font-variant-numeric: tabular-nums; }
.card-note { font-size: 0.82em; color: var(--vscode-descriptionForeground); }
/* The shape of the period, which the table of the same numbers cannot show.
   Each bar states its own count, so the height is never the only carrier. */
.bars {
  display: flex; align-items: flex-end; gap: 6px;
  height: 150px; margin: 18px 0 4px; padding-bottom: 20px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
  overflow-x: auto;
}
.bar { position: relative; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; flex: 1 0 26px; height: 100%; }
.bar-fill { width: 100%; max-width: 46px; background: var(--vscode-charts-blue, #3794ff); border-radius: 2px 2px 0 0; }
.bar-count { font-size: 0.8em; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
.bar-label { position: absolute; bottom: -19px; font-size: 0.76em; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.table-scroll { overflow-x: auto; margin-top: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
th, td { padding: 4px 12px 4px 0; text-align: left; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); }
th { font-weight: 600; white-space: nowrap; color: var(--vscode-descriptionForeground); }
td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
td.time, td.sha { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; white-space: nowrap; color: var(--vscode-descriptionForeground); }
td.repo { white-space: nowrap; font-weight: 600; }
td.subject { width: 100%; }
/* A merge is the one row whose contents are not its own, so it is tinted rather
   than left to be told apart by reading it. */
tr.is-merge { background: color-mix(in srgb, var(--vscode-charts-purple, #9a7bd0) 10%, transparent); }
.merge-tag { padding: 0 5px; border-radius: 3px; font-size: 0.8em; background: var(--vscode-charts-purple, #9a7bd0); color: var(--vscode-editor-background); }
.badge { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 9px; font-size: 0.8em; text-align: center; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
/* Named, never counted: the section is last and it is separated, so nothing in
   it can be mistaken for part of a total above. */
.unreadable { border-top-color: var(--vscode-list-warningForeground, #cca700); }
.unreadable h2 { color: var(--vscode-list-warningForeground, #cca700); }
td.reason { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.88em; }
`;
