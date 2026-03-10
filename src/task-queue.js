import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";

const Status = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export { Status };

/**
 * Persistent task queue backed by data/state.json with auto-incrementing IDs.
 *
 * Construction: `new TaskQueue({ dataDir, reposBaseDir })`
 */
export class TaskQueue {
  #tasks = [];
  #nextId = 1;
  #statePath = null;
  #reposBaseDir = "";

  /**
   * @param {{ dataDir: string, reposBaseDir: string }} opts
   */
  constructor({ dataDir, reposBaseDir } = {}) {
    if (!reposBaseDir) {
      throw new Error("TaskQueue requires reposBaseDir");
    }
    if (!dataDir) {
      throw new Error("TaskQueue requires dataDir");
    }

    this.#reposBaseDir = resolve(reposBaseDir);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(this.#reposBaseDir, { recursive: true });
    this.#statePath = resolve(dataDir, "state.json");

    if (existsSync(this.#statePath)) {
      const raw = JSON.parse(readFileSync(this.#statePath, "utf-8"));
      this.#nextId = raw.nextId || 1;
      this.#tasks = (raw.tasks || []).map((t) => ({
        ...t,
        status: t.status === Status.RUNNING ? Status.PENDING : t.status,
      }));
    }
  }

  get total() {
    return this.#tasks.length;
  }

  get reposBaseDir() {
    return this.#reposBaseDir;
  }

  #generateId() {
    const num = this.#nextId++;
    return `task-${String(num).padStart(3, "0")}`;
  }

  /**
   * Add a new task.
   *
   * - `repoPath`: any local directory path; will be copied into repos/<task-id>/
   * - `repo`: an existing directory name inside reposBaseDir (used by server ZIP upload)
   *
   * At least one of repoPath or repo must be provided.
   *
   * @param {{ prompt: string, repoPath?: string, repo?: string, model?: string }} opts
   * @returns {object} the created task
   */
  addTask({ prompt, repoPath, repo, model }) {
    if (!prompt) throw new Error("prompt is required");

    const id = this.#generateId();

    if (repoPath) {
      const srcPath = resolve(repoPath);
      if (!existsSync(srcPath) || !statSync(srcPath).isDirectory()) {
        throw new Error(`Repo path does not exist or is not a directory: ${srcPath}`);
      }
      const destPath = resolve(this.#reposBaseDir, id);
      cpSync(srcPath, destPath, { recursive: true });
      repo = id;
    }

    if (!repo) repo = id;

    const task = {
      id,
      prompt,
      repo,
      model: model || undefined,
      status: Status.PENDING,
      createdAt: new Date().toISOString(),
    };
    this.#tasks.push(task);
    this.#persist();
    return task;
  }

  /**
   * Import tasks from a JSON file.
   * Format: { "tasks": [{ "prompt": "...", "repo": "/any/path" }, ...] }
   * Each task's repo is treated as a repoPath and copied into repos/<task-id>/.
   *
   * @param {string} filePath
   * @returns {number} number of tasks imported
   */
  importFromFile(filePath) {
    const raw = readFileSync(filePath, "utf-8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid JSON in import file: ${filePath}`);
    }

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      throw new Error(`Import file must contain a non-empty "tasks" array: ${filePath}`);
    }

    const jsonDir = dirname(resolve(filePath));
    let count = 0;
    for (const t of parsed.tasks) {
      if (!t.repo) {
        throw new Error(`Each task must have "repo". Invalid entry: ${JSON.stringify(t)}`);
      }
      let promptText = t.prompt;
      if (t.promptFile) {
        const promptPath = resolve(jsonDir, t.promptFile);
        if (!existsSync(promptPath)) {
          throw new Error(`promptFile not found: ${promptPath}`);
        }
        promptText = readFileSync(promptPath, "utf-8").trim();
      }
      if (promptText == null || promptText === "") {
        throw new Error(`Task must have "prompt" or "promptFile" with non-empty content. Entry: ${JSON.stringify(t)}`);
      }
      this.addTask({ prompt: promptText, repoPath: t.repo, model: t.model });
      count++;
    }
    return count;
  }

  dequeue() {
    const task = this.#tasks.find((t) => t.status === Status.PENDING);
    if (!task) return null;
    task.status = Status.RUNNING;
    task.startedAt = new Date().toISOString();
    this.#persist();
    return task;
  }

  complete(taskId, result) {
    const task = this.#findTask(taskId);
    if (!task) return;
    task.status = Status.COMPLETED;
    task.completedAt = new Date().toISOString();
    if (task.startedAt) {
      task.durationMs = Date.parse(task.completedAt) - Date.parse(task.startedAt);
    }
    if (result !== undefined) task.result = result;
    this.#persist();
  }

  fail(taskId, error) {
    const task = this.#findTask(taskId);
    if (!task) return;
    task.status = Status.FAILED;
    task.completedAt = new Date().toISOString();
    if (task.startedAt) {
      task.durationMs = Date.parse(task.completedAt) - Date.parse(task.startedAt);
    }
    if (error !== undefined) task.error = error;
    this.#persist();
  }

  cancel(taskId) {
    const task = this.#findTask(taskId);
    if (!task) return false;
    if (task.status !== Status.PENDING) return false;
    task.status = Status.CANCELLED;
    this.#persist();
    return true;
  }

  retry(taskId) {
    const task = this.#findTask(taskId);
    if (!task) return null;
    if (task.status !== Status.COMPLETED && task.status !== Status.FAILED) {
      return null;
    }
    task.status = Status.PENDING;
    delete task.result;
    delete task.error;
    delete task.startedAt;
    delete task.completedAt;
    delete task.durationMs;
    this.#persist();
    return task;
  }

  getTask(taskId) {
    const task = this.#findTask(taskId);
    if (!task) return null;
    return { ...task };
  }

  getAllTasks() {
    return this.#tasks.map((t) => {
      const copy = { ...t };
      if (copy.result && copy.result.length > 200) {
        copy.resultPreview = copy.result.slice(0, 200) + "...";
        delete copy.result;
      } else if (copy.result) {
        copy.resultPreview = copy.result;
        delete copy.result;
      }
      return copy;
    });
  }

  getStatus() {
    const counts = { total: this.#tasks.length, pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
    for (const t of this.#tasks) {
      if (counts[t.status] !== undefined) counts[t.status]++;
    }
    return counts;
  }

  getFailedTasks() {
    return this.#tasks
      .filter((t) => t.status === Status.FAILED)
      .map(({ status, ...rest }) => rest);
  }

  #persist() {
    const data = { nextId: this.#nextId, tasks: this.#tasks };
    mkdirSync(dirname(this.#statePath), { recursive: true });
    writeFileSync(this.#statePath, JSON.stringify(data, null, 2));
  }

  #findTask(taskId) {
    return this.#tasks.find((t) => t.id === taskId) || null;
  }
}
