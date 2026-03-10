import { execFileSync } from "node:child_process";
import {
  checkDockerAvailable,
  checkDockerImage,
} from "./claude-runner.js";
import { WorkerPool } from "./worker-pool.js";

/**
 * Orchestrator — runs pre-flight checks, starts the WorkerPool,
 * waits until the queue is empty, prints a summary, and cleans up.
 *
 * @param {import('./task-queue.js').TaskQueue} queue  A pre-constructed persistent TaskQueue
 * @param {object} config  Frozen config from loadConfig()
 */
export async function orchestrate(queue, config) {
  console.log("\n=== Claude Code Trees ===\n");

  console.log("Running pre-flight checks...");

  const dockerOk = await checkDockerAvailable();
  if (!dockerOk) {
    throw new Error(
      "Docker is not available. Make sure Docker is installed and running.",
    );
  }
  console.log("  ✓ Docker daemon reachable");

  const imageOk = await checkDockerImage(config.dockerImage);
  if (!imageOk) {
    throw new Error(
      `Docker image "${config.dockerImage}" not found.\n` +
        `Build it first:  docker build -t ${config.dockerImage} .`,
    );
  }
  console.log(`  ✓ Image "${config.dockerImage}" available`);

  const queueStatus = queue.getStatus();
  console.log(`  ✓ ${queueStatus.pending} pending task(s) in queue`);
  console.log(`  ✓ Concurrency: ${config.concurrency}`);
  console.log(`  ✓ Model: ${config.model}`);
  console.log(`  ✓ Timeout: ${config.timeoutMs / 1000}s per task`);

  if (queueStatus.pending === 0) {
    console.log("\n  No pending tasks — nothing to do.\n");
    return { status: queueStatus, elapsed: "0.0" };
  }

  console.log();

  const pool = new WorkerPool(queue, config);
  const startTime = Date.now();

  let shuttingDown = false;
  const onShutdown = () => {
    if (shuttingDown) {
      console.log("\nForce-killing all containers...");
      cleanupContainers();
      process.exit(1);
    }
    shuttingDown = true;
    console.log("\nGraceful shutdown — finishing current tasks...");
    pool.stop();
  };
  process.on("SIGINT", onShutdown);
  process.on("SIGTERM", onShutdown);

  await pool.start(config.concurrency, { exitOnEmpty: true });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const status = queue.getStatus();

  console.log("\n=== Summary ===\n");
  console.log(`  Total tasks : ${status.total}`);
  console.log(`  Completed   : ${status.completed}`);
  console.log(`  Failed      : ${status.failed}`);
  console.log(`  Pending     : ${status.pending}`);
  console.log(`  Elapsed     : ${elapsed}s`);
  console.log(`  Results dir : ${config.resultsDir}`);

  const failed = queue.getFailedTasks();
  if (failed.length > 0) {
    console.log("\n  Failed tasks:");
    for (const t of failed) {
      console.log(`    - ${t.id} (repo: ${t.repo})`);
    }
  }

  console.log();

  process.off("SIGINT", onShutdown);
  process.off("SIGTERM", onShutdown);
  cleanupContainers();

  return { status, elapsed };
}

function cleanupContainers() {
  try {
    const output = execFileSync("docker", [
      "ps", "-a",
      "--filter", "name=claude-",
      "--format", "{{.Names}}",
    ]).toString().trim();

    if (!output) return;

    const names = output.split("\n").filter(Boolean);
    if (names.length > 0) {
      execFileSync("docker", ["rm", "-f", ...names]);
      console.log(`Cleaned up ${names.length} leftover container(s).`);
    }
  } catch {
    // best-effort
  }
}
