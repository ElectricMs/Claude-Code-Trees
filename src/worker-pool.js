import { EventEmitter } from "node:events";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runClaude, runClaudeStreaming, forceRemoveContainer } from "./claude-runner.js";
import { execFile } from "node:child_process";

/**
 * Persistent worker pool that continuously processes tasks from a queue.
 * Supports pause/resume and force-kill via HTTP API.
 *
 * Events: 'task:complete', 'task:fail', 'worker:idle', 'worker:busy'
 */
export class WorkerPool extends EventEmitter {
  #queue;
  #config;
  #workers = [];
  #paused = false;
  #running = false;
  /** @type {Map<string, { onData: Function|null, resolve: Function, reject: Function }>} */
  #streamListeners = new Map();

  constructor(queue, config) {
    super();
    this.#queue = queue;
    this.#config = config;
  }

  get isPaused() {
    return this.#paused;
  }

  /**
   * Start N persistent worker loops.
   * @param {number} concurrency
   */
  start(concurrency) {
    if (this.#running) return;
    this.#running = true;
    this.#paused = false;

    for (let i = 0; i < concurrency; i++) {
      const worker = {
        id: i,
        status: "idle",
        taskId: null,
        taskPrompt: null,
        containerName: null,
        startedAt: null,
        _loop: null,
      };
      this.#workers.push(worker);
      worker._loop = this.#workerLoop(worker);
    }
  }

  pause() {
    this.#paused = true;
  }

  resume() {
    this.#paused = false;
  }

  async forceKill(workerId) {
    const w = this.#workers.find((w) => w.id === workerId);
    if (!w || w.status !== "running" || !w.containerName) return false;
    try {
      await dockerKill(w.containerName);
    } catch { /* container may already be gone */ }
    return true;
  }

  async forceKillAll() {
    const kills = this.#workers
      .filter((w) => w.status === "running" && w.containerName)
      .map((w) => dockerKill(w.containerName).catch(() => {}));
    await Promise.all(kills);
  }

  getStates() {
    return this.#workers.map((w) => ({
      id: w.id,
      status: this.#paused && w.status === "idle" ? "paused" : w.status,
      taskId: w.taskId,
      taskPrompt: w.taskPrompt,
      elapsed: w.startedAt ? Date.now() - w.startedAt : null,
    }));
  }

  async stop() {
    this.#running = false;
    this.#paused = false;
    await Promise.all(this.#workers.map((w) => w._loop).filter(Boolean));
  }

  /**
   * Register a stream listener and wait for a task to be processed.
   * The worker that picks up this task will use streaming mode (stream-json)
   * and call onData(line) for each stdout line, enabling real-time SSE forwarding.
   *
   * Resolves when the task finishes (caller should read queue for final status).
   * Rejects if cancelAwait() is called before the task completes.
   */
  awaitTask(taskId, { onData } = {}) {
    return new Promise((resolve, reject) => {
      this.#streamListeners.set(taskId, { onData: onData || null, resolve, reject });
    });
  }

  /**
   * Cancel a pending awaitTask listener. Does NOT cancel the task itself —
   * if a worker already picked it up, it will finish normally (without streaming).
   */
  cancelAwait(taskId) {
    const listener = this.#streamListeners.get(taskId);
    if (listener) {
      this.#streamListeners.delete(taskId);
      listener.reject(new Error("Stream cancelled"));
    }
  }

  async #workerLoop(worker) {
    const log = (msg) => console.log(`[worker-${worker.id}] ${msg}`);

    while (this.#running) {
      if (this.#paused) {
        await sleep(500);
        continue;
      }

      const task = this.#queue.dequeue();
      if (!task) {
        await sleep(500);
        continue;
      }

      worker.status = "running";
      worker.taskId = task.id;
      worker.taskPrompt = task.prompt;
      worker.startedAt = Date.now();
      worker.containerName = null;
      this.emit("worker:busy", worker.id, task.id);

      log(`Starting task ${task.id} (repo: ${task.repoId})`);

      const listener = this.#streamListeners.get(task.id);
      const streaming = !!listener?.onData;

      let claudeResult;
      try {
        if (streaming) {
          claudeResult = await runClaudeStreaming(task, this.#config, {
            workerId: String(worker.id),
            onData: (line) => {
              try { listener.onData(line); } catch { /* SSE handler may be gone */ }
            },
          });
        } else {
          claudeResult = await runClaude(task, this.#config, {
            workerId: String(worker.id),
          });
        }
        worker.containerName = claudeResult.containerName;

        if (claudeResult.timedOut) {
          log(`Task ${task.id} timed out`);
          this.#queue.fail(task.id, "Timeout");
          this.emit("task:fail", task.id);
        } else if (claudeResult.exitCode !== 0) {
          log(`Task ${task.id} failed (exit ${claudeResult.exitCode})`);
          this.#queue.fail(task.id, claudeResult.stderr || `Exit code ${claudeResult.exitCode}`);
          this.emit("task:fail", task.id);
        } else {
          let parsed;
          if (streaming) {
            parsed = extractResultFromStreamJson(claudeResult.stdout);
          } else {
            parsed = claudeResult.stdout;
            try {
              const json = JSON.parse(claudeResult.stdout);
              if (json?.result) parsed = json.result;
            } catch { /* keep raw */ }
          }
          log(`Task ${task.id} completed in ${(claudeResult.durationMs / 1000).toFixed(1)}s`);
          this.#queue.complete(task.id, parsed);
          this.emit("task:complete", task.id);
        }

        this.#saveResultFile(task, claudeResult, worker.id);
      } catch (err) {
        log(`Task ${task.id} error: ${err.message}`);
        this.#queue.fail(task.id, err.message);
        this.emit("task:fail", task.id);
      }

      // Resolve stream listener (may already be cancelled via cancelAwait — that's fine)
      const pending = this.#streamListeners.get(task.id);
      if (pending) {
        this.#streamListeners.delete(task.id);
        pending.resolve();
      }

      if (claudeResult?.containerName) {
        await forceRemoveContainer(claudeResult.containerName).catch(() => {});
      }

      worker.status = "idle";
      worker.taskId = null;
      worker.taskPrompt = null;
      worker.containerName = null;
      worker.startedAt = null;
      this.emit("worker:idle", worker.id);
    }
  }

  #saveResultFile(task, claudeResult, workerId) {
    try {
      mkdirSync(this.#config.resultsDir, { recursive: true });
      let parsedResult = claudeResult.stdout;
      try {
        const json = JSON.parse(claudeResult.stdout);
        if (json?.result) parsedResult = json.result;
      } catch { /* keep raw */ }

      const output = {
        taskId: task.id,
        status: claudeResult.timedOut ? "timeout" : claudeResult.exitCode === 0 ? "completed" : "failed",
        prompt: task.prompt,
        repoId: task.repoId,
        result: parsedResult,
        error: claudeResult.exitCode !== 0 ? claudeResult.stderr : undefined,
        workerId: `worker-${workerId}`,
        durationMs: claudeResult.durationMs,
        model: task.model || this.#config.model,
        exitCode: claudeResult.exitCode,
      };
      const outPath = resolve(this.#config.resultsDir, `${task.id}.json`);
      writeFileSync(outPath, JSON.stringify(output, null, 2));
    } catch { /* best-effort */ }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function dockerKill(containerName) {
  return new Promise((res, rej) => {
    execFile("docker", ["kill", containerName], (err) => {
      if (err) return rej(err);
      res();
    });
  });
}

/**
 * Extract the final result text from stream-json stdout.
 * stream-json outputs one JSON object per line; the last "result" line
 * contains { type: "result", result: "full text", ... }.
 */
function extractResultFromStreamJson(stdout) {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "result" && obj.result != null) return obj.result;
    } catch { /* not JSON */ }
  }
  return stdout;
}

