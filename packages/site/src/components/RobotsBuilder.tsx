/**
 * The robots.txt builder. The reader picks a rule for each group of agents, and the figure writes
 * the robots.txt. A grid then gives the verdict for each agent on three paths. The verdicts come
 * from `parseRobots` and `decide`, the same functions that polite-crawler uses before each request.
 */
import { useMemo, useState, type ReactElement } from "react";
import type { RobotsDecision } from "polite-crawler/robots";
import { decide, parseRobots } from "polite-crawler/robots";
import { copy } from "../lib/clipboard.ts";
import type { BuilderChoices, GroupId, GroupRule } from "../lib/robots-builder.ts";
import {
  BUILDER_GROUPS,
  MCP_TOKENS,
  OTHER_TOKEN,
  RECIPE_CHOICES,
  buildRobots,
  cleanPath,
  pathsOf,
} from "../lib/robots-builder.ts";
import "../styles/owner-figures.css";

const RULES: ReadonlyArray<{ readonly id: GroupRule; readonly label: string }> = [
  { id: "allow", label: "Let in" },
  { id: "path", label: "Keep out of the path" },
  { id: "none", label: "Keep out" },
];

/** One row of the grid: an agent, and the tokens that decide its verdicts. */
interface Row {
  readonly key: string;
  readonly label: string;
  readonly note: string;
  readonly tokens: readonly string[];
  readonly tokenOnly: boolean;
}

interface Section {
  readonly id: string;
  readonly name: string;
  readonly detail: string;
  readonly rows: readonly Row[];
}

const SECTIONS: readonly Section[] = [
  ...BUILDER_GROUPS.map((group) => ({
    id: group.id,
    name: group.name,
    detail: group.detail,
    rows:
      group.id === "others"
        ? [
            {
              key: OTHER_TOKEN,
              label: OTHER_TOKEN,
              note: "an example: any crawler that no group names",
              tokens: [OTHER_TOKEN],
              tokenOnly: false,
            },
          ]
        : group.agents.map((agent) => ({
            key: agent.token,
            label: agent.token,
            note: `${agent.owner}: ${agent.does}`,
            tokens: [agent.token],
            tokenOnly: agent.tokenOnly === true,
          })),
  })),
  {
    id: "polite",
    name: "polite-crawler",
    detail: "Its MCP server obeys the rules for PoliteCrawler and for Claude-User.",
    rows: [
      {
        key: "mcp",
        label: "PoliteCrawler",
        note: "the MCP server: it obeys PoliteCrawler and Claude-User",
        tokens: MCP_TOKENS,
        tokenOnly: false,
      },
    ],
  },
];

const ROWS = SECTIONS.flatMap((section) => section.rows);

/** This function gives the text that explains one decision. */
const reason = (decision: RobotsDecision): string => {
  const rule = decision.rule;
  if (rule === undefined) return "no rule matches the path, so it is permitted";
  const verb = rule.allow ? "Allow" : "Disallow";
  const by =
    decision.by !== undefined && decision.by !== "PoliteCrawler"
      ? `, in the group for ${decision.by}`
      : "";
  return `line ${String(rule.line ?? "?")}, ${verb}: ${rule.pattern}${by}`;
};

/** The builder. */
export default function RobotsBuilder(): ReactElement {
  const [rules, setRules] = useState<Readonly<Record<GroupId, GroupRule>>>(RECIPE_CHOICES.rules);
  const [pathText, setPathText] = useState(RECIPE_CHOICES.path);
  const [privateText, setPrivateText] = useState(RECIPE_CHOICES.privatePaths.join(", "));
  const [repeat, setRepeat] = useState(RECIPE_CHOICES.repeat);
  const [signal, setSignal] = useState(RECIPE_CHOICES.signal);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState<boolean | undefined>(undefined);
  /** The group whose rule the reader changed last: the file marks its lines. */
  const [touched, setTouched] = useState<GroupId | undefined>(undefined);

  const choices: BuilderChoices = {
    rules,
    path: pathText,
    privatePaths: pathsOf(privateText),
    repeat,
    signal,
  };
  const text = buildRobots(choices);
  const robots = useMemo(() => parseRobots(text), [text]);
  const path = cleanPath(pathText) || "/members/";
  const privatePath = choices.privatePaths[0] ?? "/account/";
  const paths = [...new Set(["/", path, privatePath])];
  const verdict = (row: Row, target: string): RobotsDecision => decide(robots, row.tokens, target);

  const [chosenKey, chosenPath] = selected?.split("\u0000") ?? [];
  const chosenRow = ROWS.find((row) => row.key === chosenKey);
  const chosen =
    chosenRow !== undefined && chosenPath !== undefined && paths.includes(chosenPath)
      ? { row: chosenRow, path: chosenPath, decision: verdict(chosenRow, chosenPath) }
      : undefined;

  const agents = ROWS.filter((row) => row.key !== "mcp");
  const homeCount = agents.filter((row) => verdict(row, "/").allowed).length;
  const googlebot = ROWS.find((row) => row.key === "Googlebot")!;
  const extended = ROWS.find((row) => row.key === "Google-Extended")!;
  const googleIn = verdict(googlebot, "/").allowed;
  const extendedIn = verdict(extended, "/").allowed;
  const other = ROWS.find((row) => row.key === OTHER_TOKEN)!;
  // a named group that does not repeat the private paths replaces them with its own rules
  const leaks =
    choices.privatePaths.length > 0 && !verdict(other, privatePath).allowed
      ? agents.filter((row) => row.key !== OTHER_TOKEN && verdict(row, privatePath).allowed)
      : [];
  const lines = text.replace(/\n$/, "").split("\n");
  // the block of each group: the groups are in the order of BUILDER_GROUPS, with an empty line between two
  const blockOf = (number: number): GroupId | undefined => {
    let block = 0;
    for (let index = 0; index < number - 1; index += 1) if (lines[index] === "") block += 1;
    return BUILDER_GROUPS[block]?.id;
  };

  const setRule = (id: GroupId, rule: GroupRule): void => {
    setRules({ ...rules, [id]: rule });
    setSelected(undefined);
    setTouched(id);
  };

  return (
    <figure className="pc-rbuild not-content" aria-label="A robots.txt builder">
      <header className="pc-crawl-head">
        <div className="pc-crawl-title">
          <strong>Make a robots.txt for your site</strong>
          <span>
            The verdicts come from the robots.txt parser of polite-crawler, in your browser.
          </span>
        </div>
        <button
          type="button"
          className="pc-button"
          onClick={() => {
            setRules(RECIPE_CHOICES.rules);
            setPathText(RECIPE_CHOICES.path);
            setPrivateText(RECIPE_CHOICES.privatePaths.join(", "));
            setRepeat(RECIPE_CHOICES.repeat);
            setSignal(RECIPE_CHOICES.signal);
            setSelected(undefined);
            setTouched(undefined);
          }}
        >
          Start again from the recipe
        </button>
      </header>

      <div className="pc-rbuild-paths">
        <label className="pc-field">
          <span>The path for “Keep out of the path”</span>
          <input
            value={pathText}
            spellcheck={false}
            onInput={(event) => setPathText(event.currentTarget.value)}
          />
        </label>
        <label className="pc-field">
          <span>Private paths: no bot can fetch them</span>
          <input
            value={privateText}
            spellcheck={false}
            placeholder="For example /account/, /cart"
            onInput={(event) => setPrivateText(event.currentTarget.value)}
          />
        </label>
        <label className="pc-rbuild-check">
          <input
            type="checkbox"
            checked={repeat}
            onChange={(event) => setRepeat(event.currentTarget.checked)}
          />
          <span>Repeat the private paths in each group</span>
        </label>
        <label className="pc-rbuild-check">
          <input
            type="checkbox"
            checked={signal}
            onChange={(event) => setSignal(event.currentTarget.checked)}
          />
          <span>Add a content signal: the uses of the pages for search, AI input and training</span>
        </label>
      </div>

      <div className="pc-rbuild-verdicts">
        <p className="pc-rbuild-count" aria-live="polite">
          <strong>
            {homeCount} of {agents.length}
          </strong>{" "}
          agents can fetch the home page <code>/</code>. Pick a rule for each group.
        </p>
        <div
          className="pc-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="The rule of each group, and the verdict for each agent and each path"
        >
          <table className="pc-table pc-rbuild-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                {paths.map((target) => (
                  <th scope="col" key={target}>
                    <code>{target}</code>
                  </th>
                ))}
              </tr>
            </thead>
            {SECTIONS.map((section) => {
              const group = BUILDER_GROUPS.find((one) => one.id === section.id);
              return (
                <tbody key={section.id}>
                  <tr className="pc-rbuild-section">
                    <th scope="colgroup" colSpan={paths.length + 1}>
                      <div className="pc-rbuild-ghead">
                        <div className="pc-rbuild-gname">
                          <strong id={`pc-rbuild-${section.id}`}>{section.name}</strong>
                          <span>{section.detail}</span>
                        </div>
                        {group === undefined ? null : (
                          <div
                            className="pc-seg"
                            role="group"
                            aria-labelledby={`pc-rbuild-${section.id}`}
                          >
                            {RULES.map((rule) => (
                              <button
                                type="button"
                                key={rule.id}
                                aria-pressed={rules[group.id] === rule.id}
                                onClick={() => setRule(group.id, rule.id)}
                              >
                                {rule.id === "path" ? `Keep out of ${path}` : rule.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </th>
                  </tr>
                  {section.rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row" title={row.note}>
                        <code>{row.label}</code>
                        {row.tokenOnly ? <span className="pc-rbuild-tag">a token</span> : null}
                      </th>
                      {paths.map((target) => {
                        const decision = verdict(row, target);
                        const key = `${row.key}\u0000${target}`;
                        return (
                          <td key={target}>
                            <button
                              type="button"
                              className={`pc-verdict ${decision.allowed ? "pc-verdict-yes" : "pc-verdict-no"}`}
                              aria-pressed={selected === key}
                              title={reason(decision)}
                              onClick={() => setSelected(selected === key ? undefined : key)}
                            >
                              <span aria-hidden="true">{decision.allowed ? "✓" : "×"}</span>
                              <span className="pc-rbuild-word">
                                {decision.allowed ? "Permitted" : "Refused"}
                              </span>
                              <span className="pc-sr">{` ${row.label} on ${target}`}</span>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
        <p className="pc-rbuild-why" aria-live="polite">
          {chosen === undefined ? (
            "Select a verdict to see the line of the file that decided it."
          ) : (
            <>
              <code>{chosen.row.label}</code> on <code>{chosen.path}</code>:{" "}
              <strong>{chosen.decision.allowed ? "permitted" : "refused"}</strong>,{" "}
              {reason(chosen.decision)}.
            </>
          )}
        </p>
      </div>

      <div className="pc-rbuild-notes">
        <p className={`pc-callout ${googleIn ? "pc-callout-ok" : "pc-callout-warn"}`}>
          <strong>Google-Extended does not stop Googlebot.</strong>{" "}
          {googleIn
            ? extendedIn
              ? "Google-Extended is a token, not a crawler. Googlebot fetches the pages for Google Search, and the token tells Google if Gemini can train on them. To keep your pages out of that training, keep Google-Extended out: Googlebot still fetches each page."
              : "Google-Extended is a token, not a crawler. Your file keeps it out, so Google does not train Gemini on your pages. Googlebot still fetches each page, and the site stays in Google Search. Applebot-Extended works the same way for Applebot."
            : "Your file keeps Googlebot out, so your site leaves Google Search. Google-Extended does not change this: it controls only the training on the pages of Googlebot."}
        </p>
        {leaks.length > 0 ? (
          <p className="pc-callout pc-callout-warn" aria-live="polite">
            <strong>A named group replaces the group *.</strong>
            <span>
              {leaks.length} {leaks.length === 1 ? "agent" : "agents"} can fetch{" "}
              <code>{privatePath}</code>, for example <code>{leaks[0]!.label}</code>. Their groups
              do not repeat the private paths. Select “Repeat the private paths in each group” to
              keep them out.
            </span>
          </p>
        ) : null}
      </div>

      <div className="pc-listing pc-rbuild-file">
        <div className="pc-rbuild-filehead">
          <p className="pc-listing-head">
            <strong>robots.txt</strong>{" "}
            {chosen !== undefined
              ? `the marked line decides ${chosen.row.label} on ${chosen.path}`
              : touched !== undefined
                ? `the marked lines are the group for ${BUILDER_GROUPS.find((group) => group.id === touched)?.name ?? ""}`
                : `${String(lines.length)} lines`}
          </p>
          <button
            type="button"
            className="pc-button"
            onClick={() => {
              void copy(text).then((ok) => {
                setCopied(ok);
                if (ok) setTimeout(() => setCopied(undefined), 1500);
              });
            }}
          >
            {copied === undefined ? "Copy the file" : copied ? "Copied" : "Not copied"}
          </button>
        </div>
        {copied === false ? (
          <p className="pc-copy-error" role="status">
            The browser did not let the page copy. Select the text and copy it.
          </p>
        ) : null}
        <ol tabIndex={0} aria-label="The robots.txt">
          {lines.map((line, index) => {
            const number = index + 1;
            const decided = chosen?.decision.rule?.line === number;
            const inGroup =
              chosen?.decision.groups?.some((group) => group.line === number) ?? false;
            return (
              <li
                key={index}
                className={
                  decided
                    ? "pc-line-decided"
                    : inGroup ||
                        (chosen === undefined &&
                          touched !== undefined &&
                          line !== "" &&
                          blockOf(number) === touched)
                      ? "pc-line-group"
                      : undefined
                }
              >
                <code>{line.length > 0 ? line : " "}</code>
              </li>
            );
          })}
        </ol>
      </div>
    </figure>
  );
}
