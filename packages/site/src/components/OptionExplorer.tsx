/**
 * The explorer of the options of one command, on the page "Command line". The table of these options
 * stays in the HTML of the page. Thus a reader with no script, a search engine and llms.txt get all
 * of it. This island only hides the rows that do not match the filter. The address keeps the filter
 * after "#", for example `#command=crawl&option=max`, so a link can give a filter.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

interface Props {
  /** This text is the id of the element that holds the table. */
  readonly table: string;
  /** This list gives the order of the commands. A command of the table that is not in it comes last. */
  readonly order: readonly string[];
  /** This map gives the commands that have a table of their own, with the id of that table's section. */
  readonly elsewhere?: Readonly<Record<string, string>> | undefined;
}

/** One row of the table. */
interface Row {
  readonly element: HTMLTableRowElement;
  /** These elements are the code of the commands, in the first cell. */
  readonly codes: readonly HTMLElement[];
  /** These texts are the commands, in the order of the codes. */
  readonly commands: readonly string[];
  /** These texts are the names of the options of the second cell, in lower case, with no argument. */
  readonly names: readonly string[];
}

/** A filter. An empty text selects all. */
interface Filter {
  readonly command: string;
  readonly option: string;
}

const NONE: Filter = { command: "", option: "" };
const NOWHERE: Readonly<Record<string, string>> = {};

/** The text of an element, with no space at the two ends. */
const textOf = (element: Element): string => (element.textContent ?? "").trim();

/** This function reads the rows of the table. */
const rowsOf = (table: HTMLTableElement): Row[] =>
  [...(table.tBodies[0]?.rows ?? [])].map((element) => {
    const codes = [...(element.cells[0]?.querySelectorAll("code") ?? [])];
    const options = [...(element.cells[1]?.querySelectorAll("code") ?? [])];
    return {
      element,
      codes,
      commands: codes.map(textOf),
      names: options.map((code) => (textOf(code).split(/\s/)[0] ?? "").toLowerCase()),
    };
  });

/** The filter of an address part after "#", or undefined when that part names no filter. */
const filterOf = (hash: string): Filter | undefined => {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (!params.has("command") && !params.has("option")) return undefined;
  return { command: params.get("command") ?? "", option: params.get("option") ?? "" };
};

/** The address part after "#" of a filter, or an empty text for no filter. */
const hashOf = ({ command, option }: Filter): string => {
  const params = new URLSearchParams();
  if (command !== "") params.set("command", command);
  if (option !== "") params.set("option", option);
  const text = params.toString();
  return text === "" ? "" : `#${text}`;
};

/** This function tells if a row matches a filter. */
const matches = (row: Row, { command, option }: Filter): boolean => {
  const query = option.trim().toLowerCase();
  return (
    (command === "" || row.commands.includes(command)) &&
    (query === "" || row.names.some((name) => name.includes(query)))
  );
};

/** The explorer: a text field for the name, a chip for each command, and the count of the options. */
export default function OptionExplorer({ table, order, elsewhere }: Props): ReactElement | null {
  const away = elsewhere ?? NOWHERE;
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [wanted, setWanted] = useState<Filter>(NONE);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  // a link with a filter shows the explorer after the first render with the rows
  const reveal = useRef(false);

  // the rows of the table, the filter of the address, and each later change of the address
  useEffect(() => {
    const element = document.getElementById(table)?.querySelector("table");
    if (element === null || element === undefined) return undefined;
    setRows(rowsOf(element));
    const first = filterOf(window.location.hash);
    if (first !== undefined) {
      setWanted(first);
      reveal.current = true;
    }
    const onHash = (): void => {
      const next = filterOf(window.location.hash);
      if (next !== undefined) setWanted(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [table]);

  // the chips: all commands, the commands of the order, then the other commands of the table
  const commands = useMemo(() => {
    const inTable = new Set(rows.flatMap((row) => row.commands));
    const known = order.filter((command) => inTable.has(command) || command in away);
    return ["", ...new Set([...known, ...inTable])];
  }, [rows, order, away]);

  // a command that is not a chip (from an old link) selects all commands
  const filter = useMemo(
    () => (commands.includes(wanted.command) ? wanted : { ...wanted, command: "" }),
    [commands, wanted],
  );
  const shown = useMemo(() => rows.filter((row) => matches(row, filter)), [rows, filter]);

  // the table shows the rows of the filter, and marks the command of the filter in each row
  useEffect(() => {
    const element = rows[0]?.element.closest("table");
    if (element === null || element === undefined) return undefined;
    const heads = [...(element.tHead?.rows[0]?.cells ?? [])];
    const filtered = filter.command !== "" || filter.option.trim() !== "";
    const visible = new Set(shown);
    // While a filter applies, each column keeps its width in the whole table, so no column moves
    // while a reader types. The rows show for a moment to get these widths, in the same task, so
    // the browser paints no frame with them.
    const apply = (): void => {
      for (const head of heads) head.style.width = "";
      element.hidden = false;
      for (const row of rows) row.element.hidden = false;
      const widths = filtered ? heads.map((head) => head.getBoundingClientRect().width) : [];
      for (const row of rows) row.element.hidden = !visible.has(row);
      for (const [index, head] of heads.entries()) {
        const width = widths[index];
        if (width !== undefined && width > 0) head.style.width = `${String(width)}px`;
      }
      element.hidden = shown.length === 0;
    };
    apply();
    for (const row of rows) {
      for (const [index, code] of row.codes.entries()) {
        code.classList.toggle(
          "pc-hit",
          filter.command !== "" && row.commands[index] === filter.command,
        );
      }
    }
    if (!filtered) return undefined;
    // a different width of the window gives different widths of the columns
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [rows, shown, filter.command, filter.option]);

  // the address keeps the filter. With no filter, it keeps a different "#" part, for example a heading.
  useEffect(() => {
    if (rows.length === 0) return;
    const next = hashOf(filter);
    const now = window.location.hash;
    if (next === now || (next === "" && filterOf(now) === undefined)) return;
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, "", `${pathname}${search}${next}`);
  }, [rows.length, filter]);

  useEffect(() => {
    if (!reveal.current || rows.length === 0) return;
    reveal.current = false;
    root.current?.scrollIntoView({ block: "start" });
  }, [rows.length]);

  // with no table, the page shows the table alone, with no filter
  if (rows.length === 0) return null;

  const set = (next: Partial<Filter>): void => setWanted({ ...filter, ...next });

  // the arrow keys, Home and End move in the chips, and select the chip of the focus
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const at = commands.indexOf(filter.command);
    const last = commands.length - 1;
    const steps: Readonly<Record<string, number>> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowDown: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      ArrowUp: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    const next = steps[event.key];
    if (next === undefined) return;
    event.preventDefault();
    set({ command: commands[next] ?? "" });
    chips.current[next]?.focus();
  };

  const total = rows.length;
  const query = filter.option.trim();
  const one = shown.length <= 1;
  const command = <code>{filter.command}</code>;
  const section = away[filter.command];
  let status: ReactElement;
  if (section !== undefined) {
    status = (
      <>
        The options of {command} are in <a href={`#${section}`}>a table of their own</a>.
      </>
    );
  } else if (filter.command === "" && query === "") {
    status = (
      <>
        <strong>{total}</strong> options. Select a command, or type a part of the name of an option.
      </>
    );
  } else {
    status = (
      <>
        {shown.length === 0 ? (
          "No option"
        ) : (
          <>
            <strong>{shown.length}</strong> of {total} options
          </>
        )}
        {filter.command === "" ? null : (
          <>
            {" "}
            {one ? "applies" : "apply"} to {command}
          </>
        )}
        {filter.command !== "" && query !== "" ? " and" : null}
        {query === "" ? null : (
          <>
            {" "}
            {one ? "has" : "have"} &ldquo;{query}&rdquo; in {one ? "its" : "their"} name
          </>
        )}
        .
        {filter.command === "" ? null : (
          <span className="pc-optx-hint"> The options above also apply to each command.</span>
        )}
      </>
    );
  }

  return (
    <div ref={root} className="pc-optx not-content" role="search" aria-label="Filter the options">
      <label className="pc-field pc-optx-name">
        <span>Option name</span>
        <input
          ref={field}
          type="search"
          value={filter.option}
          placeholder="for example max"
          spellcheck={false}
          autoComplete="off"
          onInput={(event) => set({ option: event.currentTarget.value })}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || filter.option === "") return;
            event.preventDefault();
            set({ option: "" });
          }}
        />
      </label>
      <div className="pc-optx-group">
        <span className="pc-optx-label" id={`${table}-commands`}>
          Command
        </span>
        <div
          className="pc-optx-commands"
          role="radiogroup"
          aria-labelledby={`${table}-commands`}
          onKeyDown={onKey}
        >
          {commands.map((name, index) => (
            <button
              key={name === "" ? "all" : name}
              ref={(element) => {
                chips.current[index] = element;
              }}
              type="button"
              role="radio"
              className={name === "" ? "pc-chip" : "pc-chip pc-chip-code"}
              aria-checked={filter.command === name}
              tabIndex={filter.command === name ? 0 : -1}
              onClick={() => set({ command: name })}
            >
              {name === "" ? "All commands" : name}
            </button>
          ))}
        </div>
      </div>
      <p className="pc-optx-status">
        <span aria-live="polite">{status}</span>
        {filter.command === "" && query === "" ? null : (
          <button
            type="button"
            className="pc-button"
            onClick={() => {
              setWanted(NONE);
              // the button goes away, so the focus goes to the field
              field.current?.focus();
            }}
          >
            Clear the filter
          </button>
        )}
      </p>
    </div>
  );
}
