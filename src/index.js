#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig, validateConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";
import { orchestrate } from "./orchestrator.js";
import { writeControlFile } from "./worker-pool.js";

const DATA_DIR = resolve(process.cwd(), "data");

function createQueue(config) {
  return new TaskQueue({ dataDir: DATA_DIR, reposBaseDir: config.reposBaseDir });
}

const program = new Command();

program
  .name("claude-code-trees")
  .description("Multi-agent parallel orchestration for Claude Code with Docker isolation")
  .option("--env-file <path>", "Path to .env file", ".env");

// ─── add ──────────────────────────────────────────────────
program
  .command("add")
  .description("Add a single task to the queue")
  .requiredOption("--repo <path>", "Path to the code repository (any local directory)")
  .requiredOption("--prompt <text>", "Prompt / instructions for Claude Code")
  .option("--model <model>", "Model override (sonnet/haiku/opus)")
  .action((opts) => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const task = queue.addTask({
        prompt: opts.prompt,
        repoPath: opts.repo,
        model: opts.model,
      });
      console.log(`\n  ✓ ${task.id} created`);
      console.log(`    Repo copied to repos/${task.repo}/`);
      console.log(`    Prompt: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? "..." : ""}\n`);
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  });

// ─── import ───────────────────────────────────────────────
program
  .command("import")
  .description("Bulk-import tasks from a JSON file")
  .requiredOption("--file <path>", "Path to the import JSON file")
  .action((opts) => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const count = queue.importFromFile(resolve(opts.file));
      console.log(`\n  ✓ Imported ${count} task(s) from ${opts.file}\n`);
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  });

// ─── run ──────────────────────────────────────────────────
program
  .command("run")
  .description("Start agent workers to process pending tasks until the queue is empty")
  .option("-c, --concurrency <n>", "Number of parallel workers")
  .option("-m, --model <model>", "Default Claude model to use")
  .option("--timeout <ms>", "Timeout per task in milliseconds")
  .action(async (opts) => {
    try {
      const config = loadConfig({
        envFile: program.opts().envFile,
        concurrency: opts.concurrency,
        model: opts.model,
        timeout: opts.timeout,
      });
      const queue = createQueue(config);
      validateConfig(config);
      const { status } = await orchestrate(queue, config);
      process.exit(status.failed > 0 ? 1 : 0);
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(2);
    }
  });

// ─── status ───────────────────────────────────────────────
program
  .command("status")
  .description("Show queue status and active Docker containers")
  .action(() => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const s = queue.getStatus();

      console.log("\n=== Queue Status ===\n");
      console.log(`  Total     : ${s.total}`);
      console.log(`  Pending   : ${s.pending}`);
      console.log(`  Running   : ${s.running}`);
      console.log(`  Completed : ${s.completed}`);
      console.log(`  Failed    : ${s.failed}`);
      console.log(`  Cancelled : ${s.cancelled}`);

      try {
        const containers = execFileSync("docker", [
          "ps", "--filter", "name=claude-", "--format", "{{.Names}}\t{{.Status}}",
        ]).toString().trim();
        if (containers) {
          console.log("\n=== Active Containers ===\n");
          for (const line of containers.split("\n")) {
            console.log(`  ${line}`);
          }
        } else {
          console.log("\n  No active Claude containers.");
        }
      } catch {
        console.log("\n  (Docker not available — cannot list containers)");
      }

      console.log();
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  });

// ─── pause ────────────────────────────────────────────────
program
  .command("pause")
  .description("Pause workers (they finish current tasks then idle)")
  .action(() => {
    writeControlFile("pause");
    console.log("\n  ✓ Pause signal sent (workers will idle after current tasks)\n");
  });

// ─── resume ───────────────────────────────────────────────
program
  .command("resume")
  .description("Resume paused workers")
  .action(() => {
    writeControlFile("resume");
    console.log("\n  ✓ Resume signal sent\n");
  });

// ─── kill ─────────────────────────────────────────────────
program
  .command("kill")
  .description("Force-stop workers and their Docker containers")
  .option("--all", "Kill all Claude containers")
  .option("--worker <id>", "Kill a specific worker's container by ID")
  .action((opts) => {
    if (opts.all) {
      writeControlFile("stop");
      try {
        const output = execFileSync("docker", [
          "ps", "-q", "--filter", "name=claude-",
        ]).toString().trim();
        if (output) {
          const ids = output.split("\n").filter(Boolean);
          execFileSync("docker", ["kill", ...ids]);
          console.log(`\n  ✓ Killed ${ids.length} container(s) + stop signal sent\n`);
        } else {
          console.log("\n  ✓ Stop signal sent (no active containers found)\n");
        }
      } catch {
        console.log("\n  ✓ Stop signal sent (could not list/kill containers)\n");
      }
    } else if (opts.worker !== undefined) {
      const name = `claude-worker-${opts.worker}`;
      try {
        execFileSync("docker", ["kill", name]);
        console.log(`\n  ✓ Killed container ${name}\n`);
      } catch {
        console.log(`\n  ✗ Container ${name} not found or already stopped\n`);
      }
    } else {
      console.log("\n  Specify --all or --worker <id>\n");
    }
  });

program.parse();
