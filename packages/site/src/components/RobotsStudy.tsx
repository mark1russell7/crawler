/**
 * The charts and the explorer of the robots.txt study. The page gives the numbers to the charts at
 * build time, so each chart is in the HTML of the page. The explorer loads the full dataset only when a
 * reader asks for the lines that decided.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactElement } from "react";
import type { AgentRow, PackedSite, Role, StudyAgent, StudySite, Summary } from "../lib/study.ts";
import { ROLES, percent, refused, unpack } from "../lib/study.ts";

const VERDICTS = [
  { code: "N", label: "Refused by name", glyph: "✕" },
  { code: "S", label: "Refused, with all bots", glyph: "✕" },
  { code: "n", label: "Permitted by name", glyph: "✓" },
  { code: ".", label: "Permitted", glyph: "·" },
  { code: "U", label: "No answer", glyph: "–" },
] as const;

const verdictOf = (site: PackedSite, index: number): string =>
  site.state === "u" ? "U" : (site.codes[index] ?? ".");

const label = (code: string): string => VERDICTS.find((verdict) => verdict.code === code)?.label ?? "";

/** The share of the answered sites that refuse each agent, in the groups of their roles. */
export function RefusalChart({
  rows,
  answered,
}: {
  readonly rows: readonly AgentRow[];
  readonly answered: number;
}): ReactElement {
  const max = 25;
  const [hover, setHover] = useState<string | undefined>(undefined);
  return (
    <figure className="pc-chart pc-study-chart not-content">
      <figcaption>
        The share of {answered} sites that refuse each agent
        <span className="pc-chart-muted"> for a page of the site</span>
      </figcaption>
      <ul className="pc-chart-legend">
        <li>
          <span className="pc-verdict-key pc-v-N" aria-hidden="true" />
          Refused by name: a group names the agent
        </li>
        <li>
          <span className="pc-verdict-key pc-v-S" aria-hidden="true" />
          Refused with all bots: the group <code>*</code>
        </li>
      </ul>
      <div className="pc-rbars">
        <div className="pc-rbar pc-rbar-axis" aria-hidden="true">
          <span />
          <div>
            {[0, 5, 10, 15, 20, 25].map((tick) => (
              <span key={tick} style={{ left: `${String((tick / max) * 100)}%` }}>
                {tick}%
              </span>
            ))}
          </div>
          <span />
        </div>
        {ROLES.map(({ role, label: roleLabel }) => (
          <div className="pc-rbar-group" key={role} role="group" aria-label={roleLabel}>
            <div className="pc-rbar-role">{roleLabel}</div>
            {rows
              .filter((row) => row.role === role)
              .sort((a, b) => b.share - a.share)
              .map((row) => (
                <div
                  key={row.token}
                  className={`pc-rbar${hover === row.token ? " pc-hover" : ""}${hover !== undefined && hover !== row.token ? " pc-dim" : ""}`}
                  onMouseEnter={() => setHover(row.token)}
                  onMouseLeave={() => setHover(undefined)}
                >
                  <span className="pc-rbar-name">
                    <code>{row.token}</code>
                    <span className="pc-chart-muted">{row.owner}</span>
                  </span>
                  <span
                    className="pc-rbar-track"
                    role="img"
                    aria-label={`${row.token}: ${String(row.refused)} sites refuse it, ${String(row.byName)} by name and ${String(row.byStar)} with all bots`}
                  >
                    <span className="pc-rbar-part pc-v-N" style={{ width: `${String((percent(row.byName, answered) / max) * 100)}%` }} />
                    <span className="pc-rbar-part pc-v-S" style={{ width: `${String((percent(row.byStar, answered) / max) * 100)}%` }} />
                    {hover === row.token ? (
                      <span className="pc-tip pc-rbar-tip" role="tooltip">
                        <strong>{row.token}</strong>: {row.refused} of {answered} sites refuse it.
                        <br />
                        {row.byName} by name, {row.byStar} with all bots. {row.welcomed} sites permit it by name.
                      </span>
                    ) : null}
                  </span>
                  <span className="pc-rbar-value">{row.share.toFixed(1)}%</span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <details className="pc-table-view">
        <summary>Show the numbers as a table</summary>
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Company</th>
                <th>Refused by name</th>
                <th>Refused with all bots</th>
                <th>Permitted by name</th>
                <th>Share refused</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.token}>
                  <td>
                    <code>{row.token}</code>
                  </td>
                  <td>{row.owner}</td>
                  <td>{row.byName}</td>
                  <td>{row.byStar}</td>
                  <td>{row.welcomed}</td>
                  <td>{row.share.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

const MARKS: Record<Exclude<Role, "control">, { readonly label: string; readonly className: string }> = {
  training: { label: "Training crawler", className: "pc-mark-training" },
  search: { label: "Search crawler", className: "pc-mark-search" },
  user: { label: "Acts for a person", className: "pc-mark-user" },
};

/** For each company, the share of sites that refuse its training, search and user agents. */
export function CompanyChart({
  companies,
}: {
  readonly companies: ReadonlyArray<{
    readonly owner: string;
    readonly agents: ReadonlyArray<{ readonly token: string; readonly role: Role; readonly share: number }>;
  }>;
}): ReactElement {
  const max = 20;
  const [hover, setHover] = useState<string | undefined>(undefined);
  return (
    <figure className="pc-chart pc-study-chart not-content">
      <figcaption>One company, three agents: the share of sites that refuse each</figcaption>
      <ul className="pc-chart-legend">
        {Object.entries(MARKS).map(([role, mark]) => (
          <li key={role}>
            <span className={`pc-mark ${mark.className}`} aria-hidden="true" />
            {mark.label}
          </li>
        ))}
      </ul>
      <div className="pc-rbars">
        <div className="pc-rbar pc-rbar-axis" aria-hidden="true">
          <span />
          <div>
            {[0, 5, 10, 15, 20].map((tick) => (
              <span key={tick} style={{ left: `${String((tick / max) * 100)}%` }}>
                {tick}%
              </span>
            ))}
          </div>
          <span />
        </div>
        {companies.map((company) => (
          <div className="pc-rbar pc-dots-row" key={company.owner}>
            <span className="pc-rbar-name">{company.owner}</span>
            <span
              className="pc-rbar-track pc-dots-track"
              role="img"
              aria-label={company.agents.map((agent) => `${agent.token} ${agent.share.toFixed(1)}%`).join(", ")}
            >
              {company.agents.map((agent) => {
                const mark = MARKS[agent.role as Exclude<Role, "control">];
                const key = `${company.owner}:${agent.token}`;
                return (
                  <span
                    key={agent.token}
                    className={`pc-mark ${mark.className}${hover === key ? " pc-hover" : ""}`}
                    style={{ left: `${String((agent.share / max) * 100)}%` }}
                    onMouseEnter={() => setHover(key)}
                    onMouseLeave={() => setHover(undefined)}
                  >
                    {hover === key ? (
                      <span className="pc-tip" role="tooltip">
                        <code>{agent.token}</code> {agent.share.toFixed(1)}%
                      </span>
                    ) : null}
                  </span>
                );
              })}
            </span>
            <span className="pc-rbar-value pc-chart-muted">
              {company.agents.map((agent) => agent.share.toFixed(1)).join(" / ")}
            </span>
          </div>
        ))}
      </div>
      <details className="pc-table-view">
        <summary>Show the numbers as a table</summary>
        <div className="pc-table-wrap">
          <table className="pc-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Training crawler</th>
                <th>Search crawler</th>
                <th>Acts for a person</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.owner}>
                  <td>{company.owner}</td>
                  {(["training", "search", "user"] as const).map((role) => {
                    const agent = company.agents.find((candidate) => candidate.role === role);
                    return (
                      <td key={role}>
                        {agent === undefined ? "–" : (
                          <>
                            <code>{agent.token}</code> {agent.share.toFixed(1)}%
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

/** What the domains of the list answered to the request for /robots.txt. */
export function AnswerChart({ summary }: { readonly summary: Summary }): ReactElement {
  const parts = [
    { key: "o", label: "A robots.txt file", sites: summary.withFile - summary.html },
    { key: "h", label: "An HTML page in its place", sites: summary.html },
    { key: "m", label: "No file (4xx): each path permitted", sites: summary.noFile },
    { key: "u", label: "No answer: no web server, or an error", sites: summary.unreachable },
  ];
  const [hover, setHover] = useState<string | undefined>(undefined);
  return (
    <figure className="pc-chart pc-study-chart not-content">
      <figcaption>What the {summary.listSize.toLocaleString("en-US")} domains answered</figcaption>
      <div
        className="pc-stack"
        role="img"
        aria-label={parts.map((part) => `${part.label}: ${String(part.sites)}`).join(", ")}
      >
        {parts.map((part) => (
          <span
            key={part.key}
            className={`pc-stack-part pc-answer-${part.key}${hover === part.key ? " pc-hover" : ""}`}
            style={{ flexGrow: part.sites }}
            title={`${part.label}: ${String(part.sites)} domains`}
            onMouseEnter={() => setHover(part.key)}
            onMouseLeave={() => setHover(undefined)}
          />
        ))}
      </div>
      <ul className="pc-chart-legend">
        {parts.map((part) => (
          <li key={part.key} className={hover === part.key ? "pc-hover" : undefined}>
            <span className={`pc-swatch pc-answer-${part.key}`} aria-hidden="true" />
            <span>{part.label}</span>
            <strong>{part.sites}</strong>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/** The full dataset, loaded one time when a reader asks for the lines that decided. */
let full: Promise<ReadonlyMap<string, StudySite>> | undefined;
const loadFull = (url: string): Promise<ReadonlyMap<string, StudySite>> => {
  full ??= fetch(url)
    .then((response) => response.json() as Promise<{ sites: StudySite[] }>)
    .then((data) => new Map(data.sites.map((site) => [site.domain, site])));
  return full;
};

/** The text of the lines that decided for one agent: the user-agent line and the rule. */
const decidingLines = (site: StudySite | undefined, index: number): string | undefined => {
  const ref = site?.r?.[index];
  if (site === undefined || ref === undefined || ref === 0) return undefined;
  const [group, rule] = ref;
  const text = (line: number): string => `line ${String(line)}: ${site.lines?.[String(line)] ?? ""}`;
  return group > 0 ? `${text(group)}\n${text(rule)}` : text(rule);
};

const PAGE = 25;

/**
 * The grid and the table are two islands of one module, so they share this state. The table can
 * hydrate after the grid changes it: it reads the state when it starts, and then it listens.
 */
const shared: { agent: number; pick: string | undefined; picks: number } = { agent: 0, pick: undefined, picks: 0 };
const listeners = new Set<() => void>();
const publish = (change: Partial<typeof shared>): void => {
  Object.assign(shared, change);
  for (const listener of listeners) listener();
};
const TABLE_ID = "pc-study-table";

/** The grid of the domains: one square for each domain, in the order of rank, for one agent. */
export function StudyGrid({
  packed,
  agents,
  dataUrl,
}: {
  readonly packed: string;
  readonly agents: readonly StudyAgent[];
  readonly dataUrl: string;
}): ReactElement {
  const sites = useMemo(() => unpack(packed), [packed]);
  const [agent, setAgent] = useState(0);
  const [tip, setTip] = useState<{ index: number; x: number; y: number } | undefined>(undefined);
  const [details, setDetails] = useState<ReadonlyMap<string, StudySite> | undefined>(undefined);
  const gridRef = useRef<HTMLDivElement>(null);

  const want = (): void => {
    if (details === undefined) void loadFull(dataUrl).then(setDetails);
  };
  const choose = (index: number): void => {
    setAgent(index);
    publish({ agent: index });
  };

  const counts = useMemo(() => {
    const result: Record<string, number> = { N: 0, S: 0, n: 0, ".": 0, U: 0 };
    for (const site of sites) {
      const code = verdictOf(site, agent);
      result[code] = (result[code] ?? 0) + 1;
    }
    return result;
  }, [sites, agent]);
  const answered = sites.length - (counts["U"] ?? 0);
  const refusing = (counts["N"] ?? 0) + (counts["S"] ?? 0);
  const token = agents[agent]?.token ?? "";

  const onMove = (event: PointerEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-i]");
    const grid = gridRef.current;
    if (target === null || grid === null) {
      setTip(undefined);
      return;
    }
    const box = target.getBoundingClientRect();
    const outer = grid.getBoundingClientRect();
    setTip({
      index: Number(target.dataset["i"]),
      x: Math.min(Math.max(box.left - outer.left + box.width / 2, 90), outer.width - 90),
      y: box.top - outer.top,
    });
  };

  const tipSite = tip === undefined ? undefined : sites[tip.index];
  const tipLines = tipSite === undefined ? undefined : decidingLines(details?.get(tipSite.domain), agent);

  return (
    <section className="pc-tool pc-study-grid-tool not-content" aria-label="The domains, one square each">
      <div className="pc-crawl-title">
        <strong>The top {sites.length.toLocaleString("en-US")} domains, one square each</strong>
        <span>Select an agent. The squares go in the sequence of rank, from the top left. Select a square to find its site in the table.</span>
      </div>
      <div className="pc-agent-picker">
        {ROLES.map(({ role, label: roleLabel }) => (
          <div className="pc-agent-role" key={role} role="group" aria-label={roleLabel}>
            <span className="pc-agent-role-label">{roleLabel}</span>
            {agents.map((candidate, index) =>
              candidate.role === role ? (
                <button
                  key={candidate.token}
                  type="button"
                  className="pc-chip pc-chip-code"
                  aria-pressed={index === agent}
                  title={`${candidate.token} (${candidate.owner})`}
                  onClick={() => choose(index)}
                >
                  {candidate.token}
                </button>
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div className="pc-grid-frame" ref={gridRef}>
        <div
          className="pc-site-grid"
          role="img"
          aria-label={`${token}: ${String(counts["N"])} sites refuse it by name, ${String(counts["S"])} with all bots, ${String(counts["n"])} permit it by name, ${String(counts["."])} permit it, and ${String(counts["U"])} gave no answer.`}
          onPointerMove={onMove}
          onPointerEnter={want}
          onPointerLeave={() => setTip(undefined)}
          onClick={(event) => {
            const target = (event.target as HTMLElement).closest<HTMLElement>("[data-i]");
            const site = target === null ? undefined : sites[Number(target.dataset["i"])];
            if (site === undefined) return;
            publish({ pick: site.domain, picks: shared.picks + 1 });
            document.getElementById(TABLE_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        >
          {sites.map((site, index) => {
            const code = verdictOf(site, agent);
            return (
              <span
                key={site.domain}
                data-i={index}
                className={`pc-cell pc-v-${code === "." ? "o" : code}`}
                style={{ "--i": index } as CSSProperties}
              />
            );
          })}
        </div>
        {tip !== undefined && tipSite !== undefined ? (
          <div className="pc-tip pc-grid-tip" role="tooltip" style={{ left: `${String(tip.x)}px`, top: `${String(tip.y)}px` }}>
            <strong>
              {tipSite.rank}. {tipSite.domain}
            </strong>
            <span>
              <code>{token}</code>: {label(verdictOf(tipSite, agent)).toLowerCase()}
            </span>
            {tipLines !== undefined ? <pre>{tipLines}</pre> : null}
          </div>
        ) : null}
      </div>
      <ul className="pc-chart-legend pc-grid-legend">
        {VERDICTS.map((verdict) => (
          <li key={verdict.code}>
            <span className={`pc-verdict-key pc-v-${verdict.code === "." ? "o" : verdict.code}`} aria-hidden="true" />
            {verdict.label}
            <strong>{counts[verdict.code] ?? 0}</strong>
          </li>
        ))}
      </ul>
      <p className="pc-crawl-verdict" aria-live="polite">
        <code>{token}</code>: {refusing} of the {answered} sites that answered refuse it ({percent(refusing, answered).toFixed(1)}%), and{" "}
        {counts["N"]} of them name it.
      </p>
    </section>
  );
}

/** The table of the sites, with a search and the lines that decided each verdict. */
export function StudyTable({
  packed,
  agents,
  dataUrl,
}: {
  readonly packed: string;
  readonly agents: readonly StudyAgent[];
  readonly dataUrl: string;
}): ReactElement {
  const sites = useMemo(() => unpack(packed), [packed]);
  const [agent, setAgent] = useState(0);
  const [details, setDetails] = useState<ReadonlyMap<string, StudySite> | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "refuses" | "names" | "none">("all");
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<string | undefined>(undefined);
  const token = agents[agent]?.token ?? "";

  const want = (): void => {
    if (details === undefined) void loadFull(dataUrl).then(setDetails);
  };

  useEffect(() => {
    let seen = 0;
    const sync = (): void => {
      setAgent(shared.agent);
      if (shared.pick !== undefined && shared.picks !== seen) {
        seen = shared.picks;
        setQuery(shared.pick);
        setFilter("all");
        setOpen(shared.pick);
        void loadFull(dataUrl).then(setDetails);
      }
    };
    sync();
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, [dataUrl]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sites.filter((site) => {
      if (needle.length > 0 && !site.domain.includes(needle)) return false;
      if (filter === "refuses") return refused(verdictOf(site, agent));
      if (filter === "names")
        return agents.some(
          (candidate, index) => candidate.role !== "control" && (site.codes[index] === "N" || site.codes[index] === "n"),
        );
      if (filter === "none") return site.state === "u";
      return true;
    });
  }, [sites, query, filter, agent, agents]);

  useEffect(() => setShown(PAGE), [query, filter]);

  const toggle = (domain: string): void => {
    setOpen(open === domain ? undefined : domain);
    want();
  };

  return (
    <section className="pc-tool pc-study-table not-content" id={TABLE_ID} aria-label="Each site and its verdicts">
      <div className="pc-study-filters">
        <label className="pc-field">
          <span>Find a site</span>
          <input type="search" value={query} placeholder="for example wikipedia" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="pc-toggle" role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["refuses", `Refuse ${token}`],
              ["names", "Name an AI agent"],
              ["none", "No answer"],
            ] as const
          ).map(([key, text]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {text}
            </button>
          ))}
        </div>
      </div>
      <p className="pc-chart-muted pc-study-count">
        {rows.length.toLocaleString("en-US")} {rows.length === 1 ? "domain" : "domains"}. Select a domain to see the lines that decided.
      </p>
      <div className="pc-table-wrap pc-scroll">
        <table className="pc-table pc-verdict-table">
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Domain</th>
              {agents.map((candidate, index) => (
                <th
                  key={candidate.token}
                  scope="col"
                  className={`pc-vth${index === agent ? " pc-vth-on" : ""}`}
                  title={`${candidate.token} (${candidate.owner})`}
                >
                  <span>{candidate.token}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).flatMap((site) => {
              const isOpen = open === site.domain;
              const row = (
                <tr key={site.domain} className={`pc-vrow${isOpen ? " pc-vrow-open" : ""}`} onClick={() => toggle(site.domain)}>
                  <td className="pc-vrank">{site.rank}</td>
                  <td>
                    <button
                      type="button"
                      className="pc-vsite"
                      aria-expanded={isOpen}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(site.domain);
                      }}
                    >
                      {site.domain}
                    </button>
                  </td>
                  {agents.map((candidate, index) => {
                    const code = verdictOf(site, index);
                    const verdict = VERDICTS.find((entry) => entry.code === code);
                    return (
                      <td key={candidate.token} className={`pc-vcell${index === agent ? " pc-vth-on" : ""}`} title={`${candidate.token}: ${verdict?.label ?? ""}`}>
                        <span className={`pc-vglyph pc-v-${code === "." ? "o" : code}`}>
                          {verdict?.glyph}
                          <span className="pc-sr">{verdict?.label}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
              return isOpen
                ? [
                    row,
                    <tr key={`${site.domain}:open`} className="pc-vdetail">
                      <td colSpan={agents.length + 2}>
                        <SiteDetail site={site} detail={details?.get(site.domain)} agents={agents} />
                      </td>
                    </tr>,
                  ]
                : [row];
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown ? (
        <button type="button" className="pc-button" onClick={() => setShown(shown + PAGE * 2)}>
          Show {Math.min(PAGE * 2, rows.length - shown)} more
        </button>
      ) : null}
    </section>
  );
}

function SiteDetail({
  site,
  detail,
  agents,
}: {
  readonly site: PackedSite;
  readonly detail: StudySite | undefined;
  readonly agents: readonly StudyAgent[];
}): ReactElement {
  if (detail === undefined) return <p className="pc-chart-muted">The page gets the lines from the dataset…</p>;
  const host = detail.host ?? detail.domain;
  const decided = agents
    .map((agent, index) => ({ agent, index, lines: decidingLines(detail, index) }))
    .filter((entry) => entry.lines !== undefined);
  return (
    <div className="pc-vdetail-body">
      <dl className="pc-facts">
        <dt>Answer</dt>
        <dd>
          {site.state === "u"
            ? `No answer: ${detail.reason ?? "no response"}`
            : site.state === "m"
              ? `Status ${String(detail.status)}: no file, so each path is permitted`
              : site.state === "h"
                ? `Status ${String(detail.status)}, but an HTML page and not a robots.txt`
                : `Status ${String(detail.status)}, ${String(detail.bytes ?? 0)} bytes, ${String(detail.groups ?? 0)} groups`}
        </dd>
        {detail.delay !== undefined ? (
          <>
            <dt>Crawl-delay</dt>
            <dd>{detail.delay} s</dd>
          </>
        ) : null}
        {(detail.signals ?? []).length > 0 ? (
          <>
            <dt>Content signals</dt>
            <dd>
              {(detail.signals ?? []).map((line) => (
                <code key={line}>{line}</code>
              ))}
            </dd>
          </>
        ) : null}
        {site.state !== "u" ? (
          <>
            <dt>File</dt>
            <dd>
              <a href={`https://${host}/robots.txt`} rel="nofollow noopener" target="_blank">
                {host}/robots.txt
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      {decided.length > 0 ? (
        <ul className="pc-vlines">
          {decided.map(({ agent, index, lines }) => (
            <li key={agent.token}>
              <span className={`pc-vglyph pc-v-${(site.codes[index] ?? ".") === "." ? "o" : (site.codes[index] ?? ".")}`} aria-hidden="true">
                {VERDICTS.find((entry) => entry.code === site.codes[index])?.glyph}
              </span>
              <code className="pc-vlines-agent">{agent.token}</code>
              <pre>{lines}</pre>
            </li>
          ))}
        </ul>
      ) : site.state === "u" ? null : (
        <p className="pc-chart-muted">No rule of the file applies to a page path for these agents.</p>
      )}
    </div>
  );
}
