import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  Request,
  RequestId,
  Result,
  ServerNotification,
  ServerRequest,
  Task,
} from "@modelcontextprotocol/sdk/types.js";
import {
  ErrorCode,
  McpError,
  isTaskAugmentedRequestParams,
} from "@modelcontextprotocol/sdk/types.js";

/*
 * MCP tasks (the long-running task primitive of the MCP specification 2025-11-25) let a client start
 * a long tool, get a task id at once, poll the status, get the result later, and cancel the task.
 * The MCP SDK gives the protocol. This file gives the store of the tasks and the wrapper of a long
 * tool. The SDK marks its task API as experimental, so this part follows the SDK when it changes.
 */

/** These are the limits of the tasks of one MCP server. */
export const TASK_LIMITS = {
  /** A task and its result stay for this time after the task starts or ends: 1 hour by default. */
  ttlMs: 3_600_000,
  /** The longest time that a client can ask for: 1 day. */
  maxTtlMs: 86_400_000,
  /** The time that the server proposes between two polls of the status: 1 second. */
  pollMs: 1_000,
  /** The most tasks that run at one time. A new task above the limit is an error. */
  maxRunning: 8,
} as const;

/** This is a task of the server, as the status of the daemon shows it. */
export interface TaskInfo {
  /** This id is the task id that the client got. */
  readonly id: string;
  /** This value is the name of the tool, for example `crawl_site`. */
  readonly tool: string;
  /** This value is `working`, `input_required`, `completed`, `failed` or `cancelled`. */
  readonly status: string;
  /** This text tells the progress, for example `3 of 10 done`, or null. */
  readonly message: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** These options make a task store. */
export interface CrawlTaskStoreOptions {
  /** This value is the most tasks that run at one time. The default is 8. */
  readonly maxRunning?: number | undefined;
  /** This function operates when a task starts, changes its status or ends. */
  readonly onChange?: (() => void) | undefined;
}

interface Job {
  readonly controller: AbortController;
  readonly tool: string;
  /** This value is true when the client asked for a task. False is a call of a client with no tasks. */
  readonly augmented: boolean;
  readonly sessionId: string | undefined;
  /** This text tells why the task does not start: the server has its most tasks. The task then fails at once. */
  readonly refused: string | undefined;
  done: boolean;
}

/**
 * This store keeps the tasks of the long tools in memory. It wraps the `InMemoryTaskStore` of the
 * SDK, which binds each task to its session. It also keeps an abort signal for each task: the
 * cancel of a task (`tasks/cancel`) aborts the work of its tool. One store serves each session of
 * one server.
 */
export class CrawlTaskStore implements TaskStore {
  private readonly store = new InMemoryTaskStore();
  private readonly jobs = new Map<string, Job>();
  private readonly maxRunning: number;
  private closed = false;

  constructor(private readonly options: CrawlTaskStoreOptions = {}) {
    this.maxRunning = options.maxRunning ?? TASK_LIMITS.maxRunning;
  }

  private changed(): void {
    try {
      this.options.onChange?.();
    } catch {
      // the listener of the daemon writes a state file: its error does not stop a task
    }
  }

  /** This method removes the jobs whose tasks the SDK store removed at the end of their time. */
  private prune(): void {
    const live = new Set(this.store.getAllTasks().map((task) => task.taskId));
    for (const id of this.jobs.keys()) if (!live.has(id)) this.jobs.delete(id);
  }

  async createTask(
    params: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    if (this.closed) throw new McpError(ErrorCode.InvalidRequest, "the server is closing");
    this.prune();
    // a task above the limit fails at once: the SDK cannot give an error for a task request
    const running = [...this.jobs.values()].filter((job) => !job.done).length;
    const refused =
      running >= this.maxRunning
        ? `the server runs ${String(running)} tasks, its limit: wait for a task to end, or cancel one`
        : undefined;
    const asked = params.ttl ?? TASK_LIMITS.ttlMs;
    const ttl = Math.min(Math.max(1_000, asked), TASK_LIMITS.maxTtlMs);
    const task = await this.store.createTask(
      { ...params, ttl, pollInterval: params.pollInterval ?? TASK_LIMITS.pollMs },
      requestId,
      request,
      sessionId,
    );
    const name = (request.params as { name?: unknown } | undefined)?.name;
    this.jobs.set(task.taskId, {
      controller: new AbortController(),
      tool: typeof name === "string" ? name : request.method,
      augmented: isTaskAugmentedRequestParams(request.params),
      sessionId,
      refused,
      done: false,
    });
    this.changed();
    return task;
  }

  getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    return this.store.getTask(taskId, sessionId);
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    await this.store.storeTaskResult(taskId, status, result, sessionId);
    const job = this.jobs.get(taskId);
    if (job !== undefined) job.done = true;
    this.changed();
  }

  getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    return this.store.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await this.store.updateTaskStatus(taskId, status, statusMessage, sessionId);
    const job = this.jobs.get(taskId);
    if (
      job !== undefined &&
      (status === "completed" || status === "failed" || status === "cancelled")
    ) {
      job.done = true;
      // a cancel aborts the work of the tool: the requests in progress stop
      if (status === "cancelled") job.controller.abort(new Error("the client cancelled the task"));
    }
    this.changed();
  }

  listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this.store.listTasks(cursor, sessionId);
  }

  /** This method gives the abort signal of a task. A cancel of the task aborts it. */
  signal(taskId: string): AbortSignal {
    return this.jobs.get(taskId)?.controller.signal ?? AbortSignal.abort();
  }

  /** This method gives the reason that a task did not start, or undefined for a task that started. */
  refusal(taskId: string): string | undefined {
    return this.jobs.get(taskId)?.refused;
  }

  /** This method tells if the client asked for the task. False is the call of a client with no tasks. */
  augmented(taskId: string): boolean {
    return this.jobs.get(taskId)?.augmented ?? false;
  }

  /** This method gives the tasks that did not end, the oldest first. */
  running(): TaskInfo[] {
    const tasks = new Map(this.store.getAllTasks().map((task) => [task.taskId, task]));
    const infos: TaskInfo[] = [];
    for (const [id, job] of this.jobs) {
      const task = tasks.get(id);
      if (job.done || task === undefined) continue;
      infos.push({
        id,
        tool: job.tool,
        status: task.status,
        message: task.statusMessage ?? null,
        created_at: task.createdAt,
        updated_at: task.lastUpdatedAt,
      });
    }
    return infos;
  }

  /** This method gives the sessions that have a task in progress. */
  busySessions(): Set<string> {
    const busy = new Set<string>();
    for (const job of this.jobs.values()) {
      if (!job.done && job.sessionId !== undefined) busy.add(job.sessionId);
    }
    return busy;
  }

  /** This method cancels the tasks of a session that closed. Their work stops. */
  async cancelSession(
    sessionId: string,
    message = "the session of the task closed",
  ): Promise<void> {
    for (const [id, job] of this.jobs) {
      if (job.done || job.sessionId !== sessionId) continue;
      await this.updateTaskStatus(id, "cancelled", message, sessionId).catch(() => undefined);
    }
  }

  /** This method cancels each task that runs, and removes all the tasks. A second close does nothing. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, job] of this.jobs) {
      if (job.done) continue;
      await this.updateTaskStatus(id, "cancelled", "the server stopped", job.sessionId).catch(
        () => undefined,
      );
    }
    this.store.cleanup();
    this.jobs.clear();
  }
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** The extra of a task handler of the SDK: the extra of the request, with the task store of the request. */
interface TaskExtra extends Extra {
  readonly taskStore: NonNullable<Extra["taskStore"]>;
}

/** This function gives the result of a tool call: an error becomes a tool error, as the SDK makes it for a normal tool. */
const settle = async (work: Promise<CallToolResult>): Promise<CallToolResult> => {
  try {
    return await work;
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
};

/**
 * This function makes the task handler of a long tool. `run` is the normal handler of the tool.
 *
 * - When the client asks for a task, the handler gives the task at once. The work goes on, and the
 *   result goes into the store. A progress of the tool becomes the status message of the task and a
 *   progress notification. `tasks/cancel` aborts the work.
 * - When the client does not ask for a task, the work operates in the call, with the progress and the
 *   cancel of the request. This is the fallback for a client with no tasks: the SDK then gives the
 *   result at once, with no poll.
 */
export const longTask = <Args>(
  tasks: CrawlTaskStore,
  notify: (notification: ServerNotification) => Promise<void>,
  run: (args: Args, extra: Extra) => Promise<CallToolResult>,
): {
  createTask: (args: Args, extra: TaskExtra) => Promise<{ task: Task }>;
  getTask: (args: Args, extra: TaskExtra & { readonly taskId: string }) => Promise<Task>;
  getTaskResult: (
    args: Args,
    extra: TaskExtra & { readonly taskId: string },
  ) => Promise<CallToolResult>;
} => ({
  createTask: async (args, extra) => {
    const task = await extra.taskStore.createTask(
      extra.taskRequestedTtl === undefined ? {} : { ttl: extra.taskRequestedTtl },
    );
    const id = task.taskId;
    const finish = async (result: CallToolResult): Promise<void> => {
      // a cancelled task keeps its status: the store refuses a result after a cancel
      await extra.taskStore
        .storeTaskResult(id, result.isError === true ? "failed" : "completed", result)
        .catch(() => undefined);
    };
    const refused = tasks.refusal(id);
    if (refused !== undefined) {
      await finish({ content: [{ type: "text", text: refused }], isError: true });
      return { task: await extra.taskStore.getTask(id) };
    }
    if (!tasks.augmented(id)) {
      // the fallback: the call runs now, so the client gets its progress and can cancel the request
      const signal = AbortSignal.any([tasks.signal(id), extra.signal]);
      await finish(await settle(run(args, { ...extra, signal })));
      return { task: await extra.taskStore.getTask(id) };
    }
    // the response of the request goes now: later messages go on the stream of the session
    const token = extra._meta?.progressToken;
    const background: Extra = {
      ...extra,
      // the tool reports its progress to the status of the task, also when the client gave no token
      _meta: { ...extra._meta, progressToken: token ?? `task-${id}` },
      signal: tasks.signal(id),
      sendNotification: async (notification) => {
        if (notification.method === "notifications/progress") {
          const { progress, total } = notification.params;
          // the status message holds only counts: no text of a page goes outside the envelope
          const message = `${String(progress)}${total === undefined ? "" : ` of ${String(total)}`} done`;
          await extra.taskStore.updateTaskStatus(id, "working", message).catch(() => undefined);
          if (token === undefined) return;
        }
        await notify(notification).catch(() => undefined);
      },
    };
    void settle(run(args, background)).then(finish);
    return { task };
  },
  getTask: (_args, extra) => extra.taskStore.getTask(extra.taskId),
  getTaskResult: async (_args, extra) =>
    (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
});
