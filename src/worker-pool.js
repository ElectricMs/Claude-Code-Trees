import { EventEmitter } from "node:events";
import { writeFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { runClaude, forceRemoveContainer } from "./claude-runner.js";
import { execFile } from "node:child_process";

const CONTROL_FILE = resolve(process.cwd(), "data", "control.json");

/**
 * Persistent worker pool that continuously processes tasks from a queue.
 * Supports pause/resume, force-kill, control-file polling, and exitOnEmpty.
 *
 * Events: 'task:complete', 'task:fail', 'worker:idle', 'worker:busy', 'empty'
 */
export class WorkerPool extends EventEmitter {
  #queue;
  #config;
  #workers = [];
  #paused = false;
  #running = false;
  #exitOnEmpty = false;
  #doneResolve = null;

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
   * @param {{ exitOnEmpty?: boolean }} opts
   *   exitOnEmpty: when true, pool stops automatically once all workers are
   *   idle and no pending tasks remain. The returned promise resolves at that point.
   */
  start(concurrency, { exitOnEmpty = false } = {}) {
    if (this.#running) return Promise.resolve();
    this.#running = true;
    this.#paused = false;
    this.#exitOnEmpty = exitOnEmpty;

    clearControlFile();

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

    if (exitOnEmpty) {
      return new Promise((resolve) => {
        this.#doneResolve = resolve;
      });
    }
    return Promise.resolve();
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

  /** Check data/control.json for external commands (pause/resume/stop). */
  #checkControlFile() {
    try {
      if (!existsSync(CONTROL_FILE)) return;
      const raw = readFileSync(CONTROL_FILE, "utf-8");
      unlinkSync(CONTROL_FILE);
      const cmd = JSON.parse(raw);
      switch (cmd.action) {
        case "pause":
          console.log("[WorkerPool] Received control: pause");
          this.#paused = true;
          break;
        case "resume":
          console.log("[WorkerPool] Received control: resume");
          this.#paused = false;
          break;
        case "stop":
          console.log("[WorkerPool] Received control: stop");
          this.#running = false;
          break;
      }
    } catch { /* ignore read/parse errors on the control file */ }
  }

  /** Check if all workers idle + no pending tasks -> resolve exitOnEmpty promise. */
  #checkEmpty() {
    if (!this.#exitOnEmpty) return;
    const allIdle = this.#workers.every((w) => w.status === "idle");
    if (!allIdle) return;
    const status = this.#queue.getStatus();
    if (status.pending === 0 && status.running === 0) {
      this.#running = false;
      this.emit("empty");
      if (this.#doneResolve) {
        this.#doneResolve();
        this.#doneResolve = null;
      }
    }
  }

  async #workerLoop(worker) {
    const log = (msg) => console.log(`[worker-${worker.id}] ${msg}`);

    while (this.#running) {
      this.#checkControlFile();

      if (this.#paused) {
        await sleep(500);
        continue;
      }

      const task = this.#queue.dequeue();
      if (!task) {
        this.#checkEmpty();
        if (!this.#running) break;
        await sleep(500);
        continue;
      }

      worker.status = "running";
      worker.taskId = task.id;
      worker.taskPrompt = task.prompt;
      worker.startedAt = Date.now();
      worker.containerName = null;
      this.emit("worker:busy", worker.id, task.id);

      log(`Starting task ${task.id} (repo: ${task.repo})`);

      let claudeResult;
      try {
        claudeResult = await runClaude(task, this.#config, {
          workerId: String(worker.id),
        });
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
          let parsed = claudeResult.stdout;
          try {
            const json = JSON.parse(claudeResult.stdout);
            if (json?.result) parsed = json.result;
          } catch { /* keep raw */ }
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
        repo: task.repo,
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

function clearControlFile() {
  try {
    if (existsSync(CONTROL_FILE)) unlinkSync(CONTROL_FILE);
  } catch { /* ignore */ }
}

/**
 * Write a control command for an external WorkerPool process to pick up.
 * Used by CLI pause/resume/kill commands.
 */
export function writeControlFile(action) {
  mkdirSync(resolve(process.cwd(), "data"), { recursive: true });
  writeFileSync(CONTROL_FILE, JSON.stringify({ action, ts: new Date().toISOString() }));
}
