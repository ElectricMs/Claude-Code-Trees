#!/usr/bin/env node

import express from "express";
import cors from "cors";
import multer from "multer";
import { createReadStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";

import { loadConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";
import { WorkerPool } from "./worker-pool.js";
import { checkDockerAvailable, checkDockerImage } from "./claude-runner.js";

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
  res.json({
    ok: true,
    data: {
      model: config.model,
      concurrency: config.concurrency,
      timeoutMs: config.timeoutMs,
      dockerImage: config.dockerImage,
      allowedTools: config.allowedTools,
    },
  });
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

app.post("/api/tasks", upload.single("file"), async (req, res) => {
  try {
    const prompt = req.body.prompt;
    if (!prompt) {
      return res.status(400).json({ ok: false, error: "prompt is required" });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "ZIP file is required" });
    }

    const model = req.body.model || undefined;

    // Create the task — repo defaults to the task ID
    const task = queue.addTask({ prompt, model });
    const repoDir = resolve(config.reposBaseDir, task.id);

    // Extract ZIP into repos/{task-id}/
    await mkdir(repoDir, { recursive: true });
    await pipeline(
      createReadStream(req.file.path),
      unzipper.Extract({ path: repoDir }),
    );

    // If ZIP had a single root folder, hoist its contents up
    const { readdirSync, statSync, renameSync } = await import("node:fs");
    const entries = readdirSync(repoDir).filter((e) => !e.startsWith(".")  && !e.startsWith("__"));
    if (entries.length === 1 && statSync(join(repoDir, entries[0])).isDirectory()) {
      const innerDir = join(repoDir, entries[0]);
      for (const e of readdirSync(innerDir)) {
        renameSync(join(innerDir, e), join(repoDir, e));
      }
      await rm(innerDir, { recursive: true });
    }

    // Clean up uploaded temp file
    await rm(req.file.path, { force: true });

    res.json({ ok: true, data: queue.getTask(task.id) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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

// ─── Start ────────────────────────────────────────────────────

async function start() {
  console.log("\n=== Claude Code Trees — Server ===\n");

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
