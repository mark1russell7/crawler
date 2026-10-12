/**
 * The scheduler controls the pace of each host. The speed of a polite crawler is the number of
 * hosts in progress divided by the delay for each host. Thus the scheduler keeps one request in
 * progress for each host, and it waits the delay of the host between two requests. It uses its
 * concurrency across many hosts, as the back queues of the Mercator crawler do.
 *
 * The caller decides the delay after each request, and `run` gets it from the task. Only the caller
 * knows the documented rate of the source, the crawl delay of the site and the duration of the
 * request. A wait holds no global slot, so a host that waits does not block a different host.
 */

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The crawler does not ask a host again in this run after a refusal (a challenge, 403 or 402). */
export class HostStopped extends Error {
  constructor(
    readonly host: string,
    readonly reason: string,
  ) {
    super(`${host} stopped for this run: ${reason}`);
  }
}

interface HostState {
  chain: Promise<unknown>;
  nextAt: number;
  failures: number;
  stopped: string | undefined;
}

export interface Paced<T> {
  readonly value: T;
  /** This value is the time that the host rests before its next request. */
  readonly delayMs: number;
}

export class HostScheduler {
  private readonly hosts = new Map<string, HostState>();
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly clock: Clock,
    private readonly maxActive: number,
  ) {}

  private state(host: string): HostState {
    let state = this.hosts.get(host);
    if (state === undefined) {
      state = { chain: Promise.resolve(), nextAt: 0, failures: 0, stopped: undefined };
      this.hosts.set(host, state);
    }
    return state;
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxActive) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }

  /** This method starts one request on a host, in sequence, after the rest of the host. */
  run<T>(host: string, task: () => Promise<Paced<T>>): Promise<T> {
    const state = this.state(host);
    const result = state.chain.then(async () => {
      if (state.stopped !== undefined) throw new HostStopped(host, state.stopped);
      const wait = state.nextAt - this.clock.now();
      if (wait > 0) await this.clock.sleep(wait);
      await this.acquire();
      try {
        const { value, delayMs } = await task();
        state.nextAt = Math.max(state.nextAt, this.clock.now() + delayMs);
        return value;
      } finally {
        this.release();
      }
    });
    state.chain = result.catch(() => undefined);
    return result;
  }

  /** The server asked for a pause (Retry-After), or a backoff chose one. */
  park(host: string, untilMs: number): void {
    const state = this.state(host);
    state.nextAt = Math.max(state.nextAt, untilMs);
  }

  stop(host: string, reason: string): void {
    this.state(host).stopped = reason;
  }

  stoppedReason(host: string): string | undefined {
    return this.hosts.get(host)?.stopped;
  }

  /** This value counts the failures of a host in sequence, for the backoff. A success sets it to zero. */
  failed(host: string): number {
    const state = this.state(host);
    state.failures += 1;
    return state.failures;
  }

  succeeded(host: string): void {
    this.state(host).failures = 0;
  }
}

/**
 * This function gives an exponential backoff with full jitter, from the analysis of AWS. The wait
 * is random, up to base × 2^(try − 1), with a maximum. The jitter keeps retries apart.
 */
export const backoffMs = (
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number,
): number => Math.floor(random() * Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1)));
