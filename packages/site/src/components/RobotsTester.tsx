/**
 * The robots.txt tester. It parses the text with `parseRobots` and decides each path with `decide`,
 * the same functions that the crawler uses before each request. It shows the rule that decided, on
 * its line, for each user agent.
 */
import { useMemo, useState, type ReactElement } from "react";
import type { RobotsDecision } from "polite-crawler/robots";
import { decide, parseRobots } from "polite-crawler/robots";
import { readSignals } from "polite-crawler/signals";

const PRESETS: ReadonlyArray<{ readonly name: string; readonly text: string; readonly paths: string }> = [
  {
    name: "A typical site",
    text: `# Keep the search pages and the account pages out of the crawl
User-agent: *
Disallow: /search
Disallow: /account/
Allow: /account/help

Sitemap: https://www.example.com/sitemap.xml
`,
    paths: "/\n/search?q=bread\n/account/orders\n/account/help\n/blog/robots",
  },
  {
    name: "Blocks AI crawlers",
    text: `User-agent: GPTBot
User-agent: ClaudeBot
User-agent: CCBot
Disallow: /

# An assistant that fetches a page for a person
User-agent: Claude-User
Disallow: /members/

User-agent: *
Allow: /
`,
    paths: "/\n/members/news\n/about",
  },
  {
    name: "Wildcards and $",
    text: `User-agent: *
Disallow: /*.pdf$
Disallow: /*?sessionid=
Allow: /public/*.pdf$
Disallow: /tmp
`,
    paths: "/report.pdf\n/report.pdf?page=2\n/public/menu.pdf\n/shop?sessionid=42\n/tmp/a\n/tmpfile",
  },
  {
    name: "Crawl delay and content signals",
    text: `User-agent: *
Crawl-delay: 10
Content-Signal: search=yes, ai-train=no, ai-input=no
Disallow: /drafts/
`,
    paths: "/\n/drafts/next",
  },
];

const AGENTS = ["PoliteCrawler", "Claude-User", "GPTBot", "ClaudeBot", "Googlebot"] as const;

interface Row {
  readonly path: string;
  readonly agent: string;
  readonly decision: RobotsDecision;
}

/** This function gives the text that explains one decision. */
const reason = (decision: RobotsDecision): string => {
  const rule = decision.rule;
  if (rule === undefined) return "no rule matches";
  const verb = rule.allow ? "Allow" : "Disallow";
  return `line ${String(rule.line ?? "?")}: ${verb}: ${rule.pattern}`;
};

/** The tester. */
export default function RobotsTester(): ReactElement {
  const [text, setText] = useState(PRESETS[0]!.text);
  const [paths, setPaths] = useState(PRESETS[0]!.paths);
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const robots = useMemo(() => parseRobots(text), [text]);
  const agents = custom.trim().length > 0 ? [...AGENTS, custom.trim()] : [...AGENTS];
  const rows: Row[] = paths
    .split("\n")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .flatMap((path) => agents.map((agent) => ({ path, agent, decision: decide(robots, [agent], path) })));
  const chosen = selected === undefined ? undefined : rows[selected];
  const signals = readSignals(robots.signals, () => undefined);
  const lines = text.split(/\r\n|\r|\n/);
  const delay = decide(robots, ["PoliteCrawler"], "/").crawlDelaySeconds;

  return (
    <div className="pc-tool not-content">
      <div className="pc-presets" role="group" aria-label="Examples">
        {PRESETS.map((preset) => (
          <button
            key={preset.name}
            type="button"
            className="pc-chip"
            aria-pressed={text === preset.text}
            onClick={() => {
              setText(preset.text);
              setPaths(preset.paths);
              setSelected(undefined);
            }}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div className="pc-tool-grid">
        <label className="pc-field">
          <span>robots.txt</span>
          <textarea
            value={text}
            spellCheck={false}
            rows={12}
            onChange={(event) => {
              setText(event.target.value);
              setSelected(undefined);
            }}
          />
        </label>
        <div className="pc-tool-side">
          <label className="pc-field">
            <span>Paths to test, one on each line</span>
            <textarea value={paths} spellCheck={false} rows={5} onChange={(event) => setPaths(event.target.value)} />
          </label>
          <label className="pc-field">
            <span>Your own user agent</span>
            <input
              value={custom}
              placeholder="For example MyBot"
              spellCheck={false}
              onChange={(event) => setCustom(event.target.value)}
            />
          </label>
          <dl className="pc-facts">
            <div>
              <dt>Groups</dt>
              <dd>{robots.groups.length}</dd>
            </div>
            <div>
              <dt>Crawl delay for PoliteCrawler</dt>
              <dd>{delay === undefined ? "none" : `${String(delay)} s`}</dd>
            </div>
            <div>
              <dt>AI input</dt>
              <dd>{signals.ai_input === "no" ? "refused: the text is kept but held back" : signals.ai_input === "yes" ? "permitted" : "not stated"}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead>
            <tr>
              <th scope="col">Path</th>
              {agents.map((agent) => (
                <th scope="col" key={agent}>
                  {agent}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...new Set(rows.map((row) => row.path))].map((path) => (
              <tr key={path}>
                <th scope="row">
                  <code>{path}</code>
                </th>
                {agents.map((agent) => {
                  const index = rows.findIndex((row) => row.path === path && row.agent === agent);
                  const row = rows[index]!;
                  return (
                    <td key={agent}>
                      <button
                        type="button"
                        className={`pc-verdict ${row.decision.allowed ? "pc-verdict-yes" : "pc-verdict-no"}`}
                        aria-pressed={selected === index}
                        title={reason(row.decision)}
                        onClick={() => setSelected(index)}
                      >
                        <span aria-hidden="true">{row.decision.allowed ? "✓" : "×"}</span>
                        {row.decision.allowed ? "Permitted" : "Refused"}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pc-listing" aria-live="polite">
        <p className="pc-listing-head">
          {chosen === undefined
            ? "Select a result to see the rule that decided it."
            : `${chosen.agent} on ${chosen.path}: ${chosen.decision.allowed ? "permitted" : "refused"}, ${reason(chosen.decision)}.`}
        </p>
        <ol>
          {lines.map((line, index) => {
            const number = index + 1;
            const decided = chosen?.decision.rule?.line === number;
            const inGroup = chosen?.decision.groups?.some((group) => group.line === number) ?? false;
            return (
              <li key={index} className={decided ? "pc-line-decided" : inGroup ? "pc-line-group" : undefined}>
                <code>{line.length > 0 ? line : " "}</code>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
