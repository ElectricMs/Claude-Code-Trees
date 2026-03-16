#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { loadConfig } from "./config.js";
import { TaskQueue } from "./task-queue.js";

const DATA_DIR = resolve(process.cwd(), "data");

function createQueue(config) {
  return new TaskQueue({ dataDir: DATA_DIR, reposBaseDir: config.reposBaseDir });
}

const program = new Command();

program
  .name("claude-code-trees")
  .description("Multi-agent parallel orchestration for Claude Code with Docker isolation")
  .option("--env-file <path>", "Path to .env file", ".env");

// ─── repo add ────────────────────────────────────────────
program
  .command("repo-add")
  .description("Add a code repository from a local directory")
  .requiredOption("--path <dir>", "Path to the code repository directory")
  .option("--name <name>", "Optional display name for the repo")
  .action((opts) => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const repo = queue.addRepoFromPath({ repoPath: opts.path, name: opts.name });
      console.log(`\n  ✓ ${repo.id} created (name: ${repo.name})`);
      console.log(`    Directory: repos/${repo.id}/\n`);
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  });

// ─── repo list ───────────────────────────────────────────
program
  .command("repo-list")
  .description("List all code repositories")
  .action(() => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const repos = queue.getAllRepos();

      if (repos.length === 0) {
        console.log("\n  No repositories registered.\n");
        return;
      }

      console.log("\n=== Repositories ===\n");
      for (const r of repos) {
        console.log(`  ${r.id}  ${r.name}  (${r.createdAt})`);
      }
      console.log();
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  });

// ─── add ──────────────────────────────────────────────────
program
  .command("add")
  .description("Add a single task to the queue")
  .requiredOption("--repo <id-or-path>", "Repo ID (repo-XXX) or local directory path")
  .requiredOption("--prompt <text>", "Prompt / instructions for Claude Code")
  .option("--model <model>", "Model override (sonnet/haiku/opus)")
  .action((opts) => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);

      let repoId = opts.repo;

      // If it doesn't look like a repo ID, treat it as a local path
      if (!repoId.startsWith("repo-")) {
        const repo = queue.addRepoFromPath({ repoPath: opts.repo });
        console.log(`  ✓ Created repo ${repo.id} from ${opts.repo}`);
        repoId = repo.id;
      }

      const task = queue.addTask({
        prompt: opts.prompt,
        repoId,
        model: opts.model,
      });
      console.log(`\n  ✓ ${task.id} created (repo: ${task.repoId})`);
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

// ─── status ───────────────────────────────────────────────
program
  .command("status")
  .description("Show queue status and active Docker containers")
  .action(() => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const s = queue.getStatus();
      const repos = queue.getAllRepos();

      console.log("\n=== Queue Status ===\n");
      console.log(`  Total     : ${s.total}`);
      console.log(`  Pending   : ${s.pending}`);
      console.log(`  Running   : ${s.running}`);
      console.log(`  Completed : ${s.completed}`);
      console.log(`  Failed    : ${s.failed}`);
      console.log(`  Cancelled : ${s.cancelled}`);
      console.log(`  Repos     : ${repos.length}`);

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

// ─── purge ───────────────────────────────────────────────
program
  .command("purge")
  .description("Purge all runtime data: results, repos, task queue and reset all ID counters")
  .option("--force", "Skip confirmation prompt")
  .action(async (opts) => {
    try {
      const config = loadConfig({ envFile: program.opts().envFile });
      const queue = createQueue(config);
      const s = queue.getStatus();
      const repoCount = queue.getAllRepos().length;

      if (s.running > 0) {
        console.error(`\n  ✗ Cannot purge: ${s.running} task(s) still running.\n`);
        process.exit(1);
      }

      if (!opts.force) {
        const { createInterface } = await import("node:readline");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise((r) =>
          rl.question(`\n  This will delete ${s.total} task(s), ${repoCount} repo(s) and all results. Continue? [y/N] `, r),
        );
        rl.close();
        if (answer.trim().toLowerCase() !== "y") {
          console.log("  Aborted.\n");
          return;
        }
      }

      queue.purge();
      rmSync(config.reposBaseDir, { recursive: true, force: true });
      mkdirSync(config.reposBaseDir, { recursive: true });
      rmSync(config.resultsDir, { recursive: true, force: true });
      mkdirSync(config.resultsDir, { recursive: true });

      console.log("\n  ✓ Purged all tasks, repos and results.");
      console.log("  ✓ All ID counters reset to 1.\n");
    } catch (err) {
      console.error(`\n  ✗ ${err.message}\n`);
      process.exit(1);
    }
  });

program.parse();
