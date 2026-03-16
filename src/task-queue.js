import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, statSync, rmSync } from "node:fs";
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
 * Persistent task queue + repo registry backed by data/state.json.
 *
 * Construction: `new TaskQueue({ dataDir, reposBaseDir })`
 */
export class TaskQueue {
  #tasks = [];
  #repos = [];
  #nextTaskId = 1;
  #nextRepoId = 1;
  #statePath = null;
  #reposBaseDir = "";

  /**
   * @param {{ dataDir: string, reposBaseDir: string }} opts
   */
  constructor({ dataDir, reposBaseDir } = {}) {
    if (!reposBaseDir) throw new Error("TaskQueue requires reposBaseDir");
    if (!dataDir) throw new Error("TaskQueue requires dataDir");

    this.#reposBaseDir = resolve(reposBaseDir);
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(this.#reposBaseDir, { recursive: true });
    this.#statePath = resolve(dataDir, "state.json");

    if (existsSync(this.#statePath)) {
      const raw = JSON.parse(readFileSync(this.#statePath, "utf-8"));
      this.#nextTaskId = raw.nextTaskId || raw.nextId || 1;
      this.#nextRepoId = raw.nextRepoId || 1;
      this.#repos = raw.repos || [];
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

  // ─── Repo Management ─────────────────────────────────────────

  #generateRepoId() {
    const num = this.#nextRepoId++;
    return `repo-${String(num).padStart(3, "0")}`;
  }

  /**
   * Register a new repo entry. The caller is responsible for placing files
   * into `reposBaseDir/<id>/` before or after calling this.
   *
   * @param {{ name?: string }} opts
   * @returns {object} the created repo record
   */
  addRepo({ name } = {}) {
    const id = this.#generateRepoId();
    const repo = {
      id,
      name: name || id,
      createdAt: new Date().toISOString(),
    };
    this.#repos.push(repo);
    this.#persist();
    return repo;
  }

  /**
   * Register a repo from a local directory path (copies into repos/<id>/).
   *
   * @param {{ repoPath: string, name?: string }} opts
   * @returns {object} the created repo record
   */
  addRepoFromPath({ repoPath, name }) {
    const srcPath = resolve(repoPath);
    if (!existsSync(srcPath) || !statSync(srcPath).isDirectory()) {
      throw new Error(`Repo path does not exist or is not a directory: ${srcPath}`);
    }
    const repo = this.addRepo({ name });
    const destPath = resolve(this.#reposBaseDir, repo.id);
    cpSync(srcPath, destPath, { recursive: true });
    return repo;
  }

  getRepo(repoId) {
    const repo = this.#repos.find((r) => r.id === repoId);
    return repo ? { ...repo } : null;
  }

  getAllRepos() {
    return this.#repos.map((r) => ({ ...r }));
  }

  /**
   * Delete a repo record and its directory.
   * Refuses if any pending/running task references this repo.
   *
   * @param {string} repoId
   * @returns {boolean} true if deleted
   */
  deleteRepo(repoId) {
    const idx = this.#repos.findIndex((r) => r.id === repoId);
    if (idx === -1) return false;

    const inUse = this.#tasks.some(
      (t) => t.repoId === repoId && (t.status === Status.PENDING || t.status === Status.RUNNING),
    );
    if (inUse) {
      throw new Error(`Repo ${repoId} is referenced by pending/running tasks`);
    }

    this.#repos.splice(idx, 1);
    const repoDir = resolve(this.#reposBaseDir, repoId);
    if (existsSync(repoDir)) {
      rmSync(repoDir, { recursive: true, force: true });
    }
    this.#persist();
    return true;
  }

  // ─── Task Management ─────────────────────────────────────────

  #generateTaskId() {
    const num = this.#nextTaskId++;
    return `task-${String(num).padStart(3, "0")}`;
  }

  /**
   * Add a new task referencing an existing repo.
   *
   * @param {{ prompt: string, repoId: string, model?: string }} opts
   * @returns {object} the created task
   */
  addTask({ prompt, repoId, model }) {
    if (!prompt) throw new Error("prompt is required");
    if (!repoId) throw new Error("repo_id is required");
    if (!this.getRepo(repoId)) {
      throw new Error(`Repo not found: ${repoId}`);
    }

    const id = this.#generateTaskId();
    const task = {
      id,
      prompt,
      repoId,
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
   * Each task's repo is treated as a local path, uploaded as a new repo,
   * then a task is created referencing it.
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
      const repo = this.addRepoFromPath({ repoPath: t.repo, name: t.repoName });
      this.addTask({ prompt: promptText, repoId: repo.id, model: t.model });
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

  startTask(taskId) {
    const task = this.#findTask(taskId);
    if (!task || task.status !== Status.PENDING) return null;
    task.status = Status.RUNNING;
    task.startedAt = new Date().toISOString();
    this.#persist();
    return { ...task };
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

  hasRunningTasks() {
    return this.#tasks.some((t) => t.status === Status.RUNNING);
  }

  /**
   * Purge all tasks, repos and reset both ID counters to 1.
   * Caller is responsible for cleaning up results/ directory.
   *
   * @throws {Error} if any task is currently running
   */
  purge() {
    if (this.hasRunningTasks()) {
      throw new Error("Cannot purge while tasks are running");
    }
    this.#tasks = [];
    this.#repos = [];
    this.#nextTaskId = 1;
    this.#nextRepoId = 1;
    this.#persist();
  }

  #persist() {
    const data = {
      nextTaskId: this.#nextTaskId,
      nextRepoId: this.#nextRepoId,
      repos: this.#repos,
      tasks: this.#tasks,
    };
    mkdirSync(dirname(this.#statePath), { recursive: true });
    writeFileSync(this.#statePath, JSON.stringify(data, null, 2));
  }

  #findTask(taskId) {
    return this.#tasks.find((t) => t.id === taskId) || null;
  }
}
