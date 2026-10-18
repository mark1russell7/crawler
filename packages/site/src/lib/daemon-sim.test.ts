import { describe, expect, it } from "vitest";
import { DAEMON_MS, DAEMON_START, DaemonSim } from "./daemon-sim.ts";

const MINUTE = 60_000;

// the guide "The daemon, tick by tick" tells these facts about its schedule
describe("the simulation of the daemon", () => {
  it("runs the real schedule to the stop of the operator", async () => {
    const sim = new DaemonSim();
    await sim.finish();
    const view = sim.view();
    expect(view.done).toBe(true);

    // the first tick checks three entries, its page limit, and the others wait
    const first = view.ticks[0]!;
    expect(first.start).toBe(DAEMON_START);
    expect(first.summary?.stopped).toBe("max-pages");
    expect(view.checks.filter((one) => one.tick === 0)).toHaveLength(3);
    // with entries left, the next tick comes after the whole tick and its jitter
    expect(first.next).toBe(first.end! + DAEMON_MS.tick + first.jitter!);

    // the second tick stops at its budget: a host rests past the deadline
    const second = view.ticks[1]!;
    expect(second.summary?.stopped).toBe("budget");
    const deferred = view.checks.find((one) => one.tick === 1 && one.kind === "deferred");
    expect(deferred?.host).toBe("bottega-campione.example");
    expect(deferred?.note).toMatch(/^deadline reached/);

    // a jitter from 0 to 2 minutes comes after each wait
    for (const tick of view.ticks.slice(0, -1)) {
      expect(tick.jitter).toBeGreaterThanOrEqual(0);
      expect(tick.jitter).toBeLessThanOrEqual(DAEMON_MS.jitter);
    }

    // the forno page changes: one check suspects it, the next one confirms it, and one line comes
    const forno = view.checks.filter((one) => one.url === "https://forno-esempio.example/hours");
    expect(
      forno.map((one) => (one.confirmed ? "confirmed" : one.suspected ? "suspected" : one.kind)),
    ).toEqual(["new", "unchanged", "suspected", "confirmed"]);
    expect(view.lines).toHaveLength(1);
    const line = JSON.parse(view.lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({ kind: "changed", confirmed: true });
    expect(line["previous"]).not.toBeNull();

    // the museum page in maintenance is a glitch: the next check clears it
    const museo = view.checks.filter((one) => one.url === "https://museo-esempio.example/visit");
    expect(museo.at(-2)?.suspected).toBe(true);
    expect(museo.at(-1)?.kind).toBe("unchanged");
    expect(museo.at(-1)?.note).toContain("glitch");

    // the stop comes during the last tick: the check in progress ends, and the run drains
    const last = view.ticks.at(-1)!;
    expect(view.stoppedAt).toBeGreaterThan(last.start);
    expect(view.stoppedAt).toBeLessThan(last.end!);
    expect(last.summary?.stopped).toBe("cancelled");
    expect(last.summary?.reason).toContain("shutdown");
    expect(last.next).toBeNull();
    expect(view.checks.filter((one) => one.tick === last.index).at(-1)!.end).toBeGreaterThan(
      view.stoppedAt!,
    );
    expect(last.start - DAEMON_START).toBeLessThan(210 * MINUTE);
  });
});
