#!/usr/bin/env node

import express from "express";
import cors from "cors";
import multer from "multer";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import unzipper from "unzipper";

import { loadConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";
import { WorkerPool } from "./worker-pool.js";
import { checkDockerAvailable, checkDockerImage, checkNativeClaudeAvailable } from "./claude-runner.js";

const config = loadConfig({ envFile: ".env" });
const port = parseInt(process.env.SERVER_PORT || "3000", 10);
const host = process.env.SERVER_HOST || "0.0.0.0";

const dataDir = resolve(process.cwd(), "data");
const queue = new TaskQueue({ dataDir, reposBaseDir: config.reposBaseDir });
const pool = new WorkerPool(queue, config);

const app = express();
app.use(cors());
app.use(express.json());

// Static files
app.use(express.static(resolve(process.cwd(), "public")));

const uploadDir = resolve(dataDir, "uploads");
import { mkdirSync } from "node:fs";
mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

// ─── Helpers ──────────────────────────────────────────────────

/**
 * If the directory contains exactly one non-hidden sub-directory and nothing
 * else, move everything inside that sub-directory up one level.
 *
 * Uses a temporary rename to avoid ENOTEMPTY when the inner dir contains a
 * child with the same name (e.g. fastapi/fastapi/).
 */
async function hoistSingleRootDir(repoDir) {
  const { readdirSync, statSync, renameSync } = await import("node:fs");
  const entries = readdirSync(repoDir).filter(
    (e) => !e.startsWith(".") && !e.startsWith("__"),
  );
  if (entries.length !== 1 || !statSync(join(repoDir, entries[0])).isDirectory()) {
    return;
  }

  const innerDir = join(repoDir, entries[0]);
  const tempDir = join(repoDir, `__hoist_${Date.now()}__`);
  renameSync(innerDir, tempDir);

  for (const e of readdirSync(tempDir)) {
    renameSync(join(tempDir, e), join(repoDir, e));
  }
  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Try to extract incremental text from a Claude Code stream-json line.
 */
function extractStreamText(obj) {
  if (obj.type === "content_block_delta" && obj.delta?.text) {
    return obj.delta.text;
  }
  if (obj.type === "assistant" && obj.message?.content) {
    const texts = obj.message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text);
    return texts.length ? texts.join("") : null;
  }
  if (obj.type === "assistant" && typeof obj.text === "string") {
    return obj.text;
  }
  return null;
}

// ─── Status & Config ──────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  res.json({
    ok: true,
    data: {
      queue: queue.getStatus(),
      workers: pool.getStates(),
      paused: pool.isPaused,
    },
  });
});

app.get("/api/config", (_req, res) => {
  const data = {
    agentMode: config.agentMode,
    model: config.model,
    concurrency: config.concurrency,
    timeoutMs: config.timeoutMs,
    allowedTools: config.allowedTools,
  };
  if (config.agentMode === "docker") {
    data.dockerImage = config.dockerImage;
  } else {
    data.nativeClaudeCmd = config.nativeClaudeCmd;
  }
  res.json({ ok: true, data });
});

// ─── Repos CRUD ───────────────────────────────────────────────

app.get("/api/repos", (_req, res) => {
  res.json({ ok: true, data: queue.getAllRepos() });
});

app.get("/api/repos/:id", (req, res) => {
  const repo = queue.getRepo(req.params.id);
  if (!repo) return res.status(404).json({ ok: false, error: "Repo not found" });
  res.json({ ok: true, data: repo });
});

app.post("/api/repos", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "ZIP file is required" });
    }

    const name = req.body.name || undefined;
    const repo = queue.addRepo({ name });
    const repoDir = resolve(config.reposBaseDir, repo.id);

    try {
      await mkdir(repoDir, { recursive: true });
      await createReadStream(req.file.path)
        .pipe(unzipper.Extract({ path: repoDir }))
        .promise();
      await hoistSingleRootDir(repoDir);
    } catch (extractErr) {
      // Roll back: remove the repo record and directory on extraction failure
      try { queue.deleteRepo(repo.id); } catch { /* best-effort */ }
      await rm(req.file.path, { force: true }).catch(() => {});
      return res.status(500).json({ ok: false, error: `ZIP extraction failed: ${extractErr.message}` });
    }

    await rm(req.file.path, { force: true });
    res.json({ ok: true, data: queue.getRepo(repo.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/repos/:id", (req, res) => {
  try {
    const ok = queue.deleteRepo(req.params.id);
    if (!ok) {
      return res.status(404).json({ ok: false, error: "Repo not found" });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Tasks CRUD ───────────────────────────────────────────────

app.get("/api/tasks", (_req, res) => {
  res.json({ ok: true, data: queue.getAllTasks() });
});

app.get("/api/tasks/:id", (req, res) => {
  const task = queue.getTask(req.params.id);
  if (!task) return res.status(404).json({ ok: false, error: "Task not found" });
  res.json({ ok: true, data: task });
});

app.post("/api/tasks", (req, res) => {
  try {
    const { prompt, repo_id, model } = req.body;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: "prompt is required" });
    }
    if (!repo_id) {
      return res.status(400).json({ ok: false, error: "repo_id is required" });
    }
    const task = queue.addTask({ prompt, repoId: repo_id, model });
    res.json({ ok: true, data: queue.getTask(task.id) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete("/api/tasks/:id", (req, res) => {
  const ok = queue.cancel(req.params.id);
  if (!ok) {
    return res.status(400).json({ ok: false, error: "Can only cancel pending tasks" });
  }
  res.json({ ok: true });
});

app.post("/api/tasks/:id/retry", (req, res) => {
  const task = queue.retry(req.params.id);
  if (!task) {
    return res.status(400).json({ ok: false, error: "Can only retry completed or failed tasks" });
  }
  res.json({ ok: true, data: task });
});

// ─── /api/tasks/sse — create task, callback with result ──────

app.post("/api/tasks/sse", (req, res) => {
  let taskId = null;

  try {
    const { prompt, repo_id, model, user_id } = req.body;
    if (!user_id) {
      return res.status(400).json({
        ok: false, error: "user_id is required",
        code: "MISSING_USER_ID", phase: "validation",
      });
    }
    if (!prompt) {
      return res.status(400).json({
        ok: false, error: "prompt is required",
        code: "MISSING_PROMPT", phase: "validation",
      });
    }
    if (!repo_id) {
      return res.status(400).json({
        ok: false, error: "repo_id is required",
        code: "MISSING_REPO_ID", phase: "validation",
      });
    }

    const task = queue.addTask({ prompt, repoId: repo_id, model });
    taskId = task.id;

    res.json({ ok: true, data: queue.getTask(task.id) });

    processAndCallback(task.id, user_id).catch((err) => {
      console.error(`[sse-callback] ${task.id} callback failed: ${err.message}`);
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({
        ok: false, error: err.message,
        code: "INTERNAL_ERROR", phase: "unknown", taskId,
      });
    }
  }
});

/**
 * Wait for a task to finish, then POST the result to the callback endpoint
 * as an SSE-formatted body: `data: {"content":"..."}\n\n`.
 */
async function processAndCallback(taskId, userId) {
  const log = (msg) => console.log(`[sse-callback] ${taskId} ${msg}`);

  try {
    await pool.awaitTask(taskId);
  } catch {
    // awaitTask rejects if cancelAwait is called; task may still complete via worker
  }

  const finalTask = queue.getTask(taskId);
  if (!finalTask) {
    log("task not found after processing");
    return;
  }

  const callbackBase = config.callbackBaseUrl || `http://localhost:${port}`;
  const callbackUrl = `${callbackBase}/api/v1/ai-stream-card/${encodeURIComponent(userId)}`;

  const answer = finalTask.status === "completed"
    ? (finalTask.result || "")
    : `[${finalTask.status}] ${finalTask.error || "Task did not complete successfully"}`;

  const sseBody = `data: ${JSON.stringify({ content: answer })}\n\n`;

  log(`POSTing result to ${callbackUrl} (${sseBody.length} bytes)`);

  const resp = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "text/event-stream" },
    body: sseBody,
  });

  if (!resp.ok) {
    log(`callback responded ${resp.status}: ${await resp.text().catch(() => "")}`);
  } else {
    log("callback delivered successfully");
  }
}

// ─── /api/tasks/sse2 — direct SSE streaming endpoint ─────────

app.post("/api/tasks/sse2", (req, res) => {
  let taskId = null;

  try {
    const { prompt, repo_id, model } = req.body;
    if (!prompt) {
      return res.status(400).json({
        ok: false, error: "prompt is required",
        code: "MISSING_PROMPT", phase: "validation",
      });
    }
    if (!repo_id) {
      return res.status(400).json({
        ok: false, error: "repo_id is required",
        code: "MISSING_REPO_ID", phase: "validation",
      });
    }

    const task = queue.addTask({ prompt, repoId: repo_id, model });
    taskId = task.id;

    // Switch to SSE mode
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const sendSSE = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendSSE({ type: "task_created", data: queue.getTask(task.id) });

    let closed = false;
    req.on("close", () => {
      closed = true;
      pool.cancelAwait(task.id);
    });

    pool.awaitTask(task.id, {
      onData: (line) => {
        if (closed) return;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "result") return;
          const text = extractStreamText(obj);
          if (text) sendSSE({ content: text });
        } catch { /* non-JSON line, ignore */ }
      },
    }).then(() => {
      if (closed) return;

      const finalTask = queue.getTask(task.id);
      if (finalTask.status === "completed") {
        sendSSE({ type: "task_complete", ok: true, data: finalTask });
      } else if (finalTask.durationMs != null && finalTask.error === "Timeout") {
        sendSSE({
          type: "task_error", ok: false,
          error: `Task timed out after ${(finalTask.durationMs / 1000).toFixed(1)}s`,
          code: "TASK_TIMEOUT", phase: "processing", taskId,
          durationMs: finalTask.durationMs,
        });
      } else {
        sendSSE({
          type: "task_error", ok: false,
          error: finalTask.error || "Task failed",
          code: "TASK_FAILED", phase: "processing", taskId,
          exitCode: finalTask.error?.match(/Exit code (\d+)/)?.[1] ?? null,
        });
      }
      res.end();
    }).catch((err) => {
      if (closed) return;
      const isCancel = err.message === "Stream cancelled";
      sendSSE({
        type: "task_error", ok: false,
        error: err.message || "Task processing failed",
        code: isCancel ? "STREAM_CANCELLED" : "RUNNER_ERROR",
        phase: "processing", taskId,
      });
      res.end();
    });
  } catch (err) {
    const payload = {
      ok: false, error: err.message,
      code: "INTERNAL_ERROR", phase: "unknown", taskId,
    };
    if (!res.headersSent) {
      res.status(400).json(payload);
    } else {
      try { res.write(`data: ${JSON.stringify({ type: "task_error", ...payload })}\n\n`); }
      catch { /* response may already be closed */ }
      res.end();
    }
  }
});

// ─── Worker Control ───────────────────────────────────────────

app.post("/api/workers/pause", (_req, res) => {
  pool.pause();
  res.json({ ok: true });
});

app.post("/api/workers/resume", (_req, res) => {
  pool.resume();
  res.json({ ok: true });
});

app.post("/api/workers/:id/kill", async (req, res) => {
  const workerId = parseInt(req.params.id, 10);
  const ok = await pool.forceKill(workerId);
  if (!ok) {
    return res.status(400).json({ ok: false, error: "Worker not running or not found" });
  }
  res.json({ ok: true });
});

app.post("/api/workers/kill-all", async (_req, res) => {
  await pool.forceKillAll();
  res.json({ ok: true });
});

// ─── Purge ────────────────────────────────────────────────────

app.post("/api/purge", async (_req, res) => {
  try {
    queue.purge();
    await rm(config.reposBaseDir, { recursive: true, force: true });
    await mkdir(config.reposBaseDir, { recursive: true });
    await rm(config.resultsDir, { recursive: true, force: true });
    await mkdir(config.resultsDir, { recursive: true });
    res.json({
      ok: true,
      message: "All tasks, repos and results have been purged. ID counters reset to 1.",
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────

async function start() {
  console.log("\n=== Claude Code Trees — Server ===\n");
  console.log(`  Agent mode: ${config.agentMode}`);

  if (config.agentMode === "docker") {
    const dockerOk = await checkDockerAvailable();
    if (!dockerOk) {
      console.error("  ✗ Docker is not available");
      process.exit(1);
    }
    console.log("  ✓ Docker daemon reachable");

    const imageOk = await checkDockerImage(config.dockerImage);
    if (!imageOk) {
      console.error(`  ✗ Docker image "${config.dockerImage}" not found`);
      console.error(`    Build it first: docker build -t ${config.dockerImage} .`);
      process.exit(1);
    }
    console.log(`  ✓ Image "${config.dockerImage}" available`);
  } else {
    const cmdOk = await checkNativeClaudeAvailable(config.nativeClaudeCmd);
    if (!cmdOk) {
      console.warn(`  ⚠ Native command "${config.nativeClaudeCmd}" not found in PATH`);
      console.warn("    Make sure Claude Code is installed (npm install -g @anthropic-ai/claude-code)");
    } else {
      console.log(`  ✓ Native command "${config.nativeClaudeCmd}" available`);
    }
  }

  pool.start(config.concurrency);
  console.log(`  ✓ ${config.concurrency} worker(s) started`);

  const queueStatus = queue.getStatus();
  if (queueStatus.pending > 0) {
    console.log(`  ✓ Restored ${queueStatus.pending} pending task(s) from previous session`);
  }

  app.listen(port, host, () => {
    console.log(`\n  ✓ Server listening on http://${host}:${port}`);
    console.log(`    Dashboard: http://localhost:${port}\n`);
  });

  process.on("SIGINT", async () => {
    console.log("\n  Shutting down...");
    await pool.stop();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await pool.stop();
    process.exit(0);
  });
}

start();
