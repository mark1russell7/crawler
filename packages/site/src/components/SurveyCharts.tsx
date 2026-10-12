/**
 * The charts of the survey of 300 restaurant websites. Each chart shows its values as text too, and
 * a table below each chart gives the same numbers.
 */
import { useState, type ReactElement } from "react";

const OUTCOMES = [
  { label: "Read", sites: 231, tone: "good", icon: "✓" },
  { label: "robots.txt unreadable", sites: 35, tone: "neutral", icon: "?" },
  { label: "Refused by robots.txt", sites: 13, tone: "warning", icon: "!" },
  { label: "A bot wall", sites: 13, tone: "critical", icon: "×" },
  { label: "Not found", sites: 8, tone: "muted", icon: "–" },
] as const;

const BUILDERS = [
  { name: "Squarespace", sites: 51, home: 44, links: 47 },
  { name: "Custom or other", sites: 56, home: 23, links: 35 },
  { name: "WordPress", sites: 33, home: 23, links: 28 },
  { name: "Wix", sites: 27, home: 19, links: 22 },
  { name: "BentoBox", sites: 23, home: 5, links: 18 },
  { name: "SpotHopper", sites: 12, home: 10, links: 11 },
  { name: "GoDaddy", sites: 11, home: 5, links: 8 },
  { name: "Next.js", sites: 7, home: 4, links: 5 },
  { name: "Square Online", sites: 5, home: 2, links: 3 },
  { name: "Shopify", sites: 3, home: 3, links: 3 },
] as const;

const VERSIONS = [
  { name: "The first run", read: 168, suggested: 131 },
  { name: "Whole pages, hours in any order", read: 173, suggested: 165 },
  { name: "Kept robots.txt, paired columns", read: 182, suggested: 174 },
] as const;

const READ_SITES = 231;
const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

/** The outcomes of 300 sites as one bar, with the parts in sequence. */
export function OutcomesChart(): ReactElement {
  const total = OUTCOMES.reduce((sum, outcome) => sum + outcome.sites, 0);
  const [hover, setHover] = useState<string | undefined>(undefined);
  return (
    <figure className="pc-chart not-content">
      <figcaption>What the crawler could do with 300 restaurant websites</figcaption>
      <div className="pc-stack" role="img" aria-label={OUTCOMES.map((outcome) => `${outcome.label}: ${String(outcome.sites)}`).join(", ")}>
        {OUTCOMES.map((outcome) => (
          <span
            key={outcome.label}
            className={`pc-stack-part pc-tone-${outcome.tone}${hover === outcome.label ? " pc-hover" : ""}`}
            style={{ flexGrow: outcome.sites }}
            title={`${outcome.label}: ${String(outcome.sites)} sites (${percent(outcome.sites, total)})`}
            onMouseEnter={() => setHover(outcome.label)}
            onMouseLeave={() => setHover(undefined)}
          />
        ))}
      </div>
      <ul className="pc-chart-legend">
        {OUTCOMES.map((outcome) => (
          <li key={outcome.label} className={hover === outcome.label ? "pc-hover" : undefined}>
            <span className={`pc-swatch pc-tone-${outcome.tone}`} aria-hidden="true">
              {outcome.icon}
            </span>
            <span>{outcome.label}</span>
            <strong>{outcome.sites}</strong>
            <span className="pc-chart-muted">{percent(outcome.sites, total)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** For each site builder: the share of sites with hours from the homepage, and with the links followed. */
export function BuildersChart(): ReactElement {
  const rows = [...BUILDERS].sort((a, b) => b.links / b.sites - b.home / b.sites - (a.links / a.sites - a.home / a.sites));
  return (
    <figure className="pc-chart not-content">
      <figcaption>Sites with hours that the crawler read, by site builder</figcaption>
      <ul className="pc-chart-legend">
        <li>
          <span className="pc-dot pc-dot-hollow" aria-hidden="true" />
          The homepage only
        </li>
        <li>
          <span className="pc-dot" aria-hidden="true" />
          The homepage and the linked pages
        </li>
      </ul>
      <div className="pc-dumbbells">
        <div className="pc-dumbbell-axis" aria-hidden="true">
          <span />
          <div>
            {[0, 25, 50, 75, 100].map((tick) => (
              <span key={tick} style={{ left: `${String(tick)}%` }}>
                {tick}%
              </span>
            ))}
          </div>
          <span />
        </div>
        {rows.map((row) => {
          const home = (row.home / row.sites) * 100;
          const links = (row.links / row.sites) * 100;
          return (
            <div className="pc-dumbbell" key={row.name} title={`${row.name}: ${String(row.home)} of ${String(row.sites)} from the homepage, ${String(row.links)} with the links followed`}>
              <span className="pc-dumbbell-name">
                {row.name}
                <span className="pc-chart-muted"> {row.sites} sites</span>
              </span>
              <span className="pc-dumbbell-track">
                <span className="pc-dumbbell-line" style={{ left: `${String(home)}%`, width: `${String(links - home)}%` }} />
                <span className="pc-dot pc-dot-hollow" style={{ left: `${String(home)}%` }} />
                <span className="pc-dot" style={{ left: `${String(links)}%` }} />
              </span>
              <span className="pc-dumbbell-value">
                {percent(row.home, row.sites)} to <strong>{percent(row.links, row.sites)}</strong>
              </span>
            </div>
          );
        })}
      </div>
      <details className="pc-table-view">
        <summary>The numbers as a table</summary>
        <table className="pc-table">
          <thead>
            <tr>
              <th scope="col">Site builder</th>
              <th scope="col">Sites</th>
              <th scope="col">Hours from the homepage</th>
              <th scope="col">Hours with the links followed</th>
            </tr>
          </thead>
          <tbody>
            {BUILDERS.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                <td>{row.sites}</td>
                <td>{row.home}</td>
                <td>{row.links}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** The sites with hours, read and suggested, for three versions of the reader. */
export function ProgressChart(): ReactElement {
  return (
    <figure className="pc-chart not-content">
      <figcaption>Sites with hours, of the 231 sites that the crawler read, for three versions of the reader</figcaption>
      <ul className="pc-chart-legend">
        <li>
          <span className="pc-key-bar pc-series-1" aria-hidden="true" />
          Hours read
        </li>
        <li>
          <span className="pc-key-bar pc-series-2" aria-hidden="true" />
          Hours suggested as the hours of the venue
        </li>
      </ul>
      <ol className="pc-bars">
        {VERSIONS.map((version) => (
          <li key={version.name}>
            <span className="pc-bars-name">{version.name}</span>
            <span className="pc-bars-row">
              <span className="pc-bar pc-series-1" style={{ width: `${String((version.read / READ_SITES) * 100)}%` }} />
              <strong>{version.read}</strong>
            </span>
            <span className="pc-bars-row">
              <span className="pc-bar pc-series-2" style={{ width: `${String((version.suggested / READ_SITES) * 100)}%` }} />
              <strong>{version.suggested}</strong>
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
