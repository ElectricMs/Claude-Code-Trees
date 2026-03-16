import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";

/**
 * Run a Claude Code analysis inside a Docker container.
 *
 * The target repo is mounted read-only at /workspace inside the container.
 * Returns { exitCode, stdout, stderr, durationMs, timedOut }.
 */
export function runClaude(task, config, { workerId, signal } = {}) {
  return new Promise((resolveP, rejectP) => {
    const repoAbsPath = resolve(config.reposBaseDir, task.repoId);
    const containerName = `claude-${workerId}-${task.id}`.replace(
      /[^a-zA-Z0-9_.-]/g,
      "-",
    );
    const model = task.model || config.model;
    const timeoutMs = task.timeoutMs || config.timeoutMs;

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      containerName,
      "-v",
      `${repoAbsPath}:/workspace:ro`,
      "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
    ];

    if (config.baseUrl) {
      dockerArgs.push("-e", `ANTHROPIC_BASE_URL=${config.baseUrl}`);
    }
    if (config.apiTimeoutMs) {
      dockerArgs.push("-e", `API_TIMEOUT_MS=${config.apiTimeoutMs}`);
    }
    if (config.dockerMemoryLimit) {
      dockerArgs.push("--memory", config.dockerMemoryLimit);
    }

    dockerArgs.push(
      config.dockerImage,
      "-p",
      "--dangerously-skip-permissions",
      "--tools",
      config.allowedTools,
      "--no-session-persistence",
      "--output-format",
      "json",
      "--model",
      model,
      task.prompt,
    );

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut,
        containerName,
      });
    };

    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    });

    // Timeout: graceful stop then force kill
    const timer = setTimeout(async () => {
      timedOut = true;
      try {
        await dockerExec("stop", ["-t", "10", containerName]);
      } catch {
        await dockerExec("kill", [containerName]).catch(() => {});
      }
    }, timeoutMs);

    // External abort (e.g. SIGINT graceful shutdown)
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (!settled) {
            dockerExec("stop", ["-t", "5", containerName]).catch(() => {
              dockerExec("kill", [containerName]).catch(() => {});
            });
          }
        },
        { once: true },
      );
    }
  });
}

/**
 * Run Claude Code inside a Docker container with streaming output.
 *
 * Uses `--output-format stream-json` so stdout emits one JSON object per line.
 * The `onData(line)` callback is invoked for each complete line from stdout,
 * allowing the caller to forward content to an SSE client in real time.
 *
 * Returns the same shape as runClaude: { exitCode, stdout, stderr, durationMs, timedOut, containerName }.
 */
export function runClaudeStreaming(task, config, { workerId, signal, onData } = {}) {
  return new Promise((resolveP, rejectP) => {
    const repoAbsPath = resolve(config.reposBaseDir, task.repoId);
    const containerName = `claude-${workerId}-${task.id}`.replace(
      /[^a-zA-Z0-9_.-]/g,
      "-",
    );
    const model = task.model || config.model;
    const timeoutMs = task.timeoutMs || config.timeoutMs;

    const dockerArgs = [
      "run",
      "--rm",
      "--name",
      containerName,
      "-v",
      `${repoAbsPath}:/workspace:ro`,
      "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
    ];

    if (config.baseUrl) {
      dockerArgs.push("-e", `ANTHROPIC_BASE_URL=${config.baseUrl}`);
    }
    if (config.apiTimeoutMs) {
      dockerArgs.push("-e", `API_TIMEOUT_MS=${config.apiTimeoutMs}`);
    }
    if (config.dockerMemoryLimit) {
      dockerArgs.push("--memory", config.dockerMemoryLimit);
    }

    dockerArgs.push(
      config.dockerImage,
      "-p",
      "--dangerously-skip-permissions",
      "--tools",
      config.allowedTools,
      "--no-session-persistence",
      "--output-format",
      "stream-json",
      "--model",
      model,
      task.prompt,
    );

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let lineBuf = "";

    const proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onData) {
        lineBuf += text;
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop();
        for (const line of lines) {
          if (line.trim()) onData(line.trim());
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onData && lineBuf.trim()) onData(lineBuf.trim());
      resolveP({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut,
        containerName,
      });
    };

    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    });

    const timer = setTimeout(async () => {
      timedOut = true;
      try {
        await dockerExec("stop", ["-t", "10", containerName]);
      } catch {
        await dockerExec("kill", [containerName]).catch(() => {});
      }
    }, timeoutMs);

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (!settled) {
            dockerExec("stop", ["-t", "5", containerName]).catch(() => {
              dockerExec("kill", [containerName]).catch(() => {});
            });
          }
        },
        { once: true },
      );
    }
  });
}

/**
 * Force-remove a container by name (best-effort cleanup).
 */
export function forceRemoveContainer(containerName) {
  return dockerExec("rm", ["-f", containerName]).catch(() => {});
}

/**
 * Check that the Docker daemon is reachable.
 */
export async function checkDockerAvailable() {
  try {
    await dockerExec("info", []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a Docker image exists locally.
 * Uses `docker images -q` which is more reliable than `docker image inspect`
 * with Docker Desktop's containerd image store.
 */
export async function checkDockerImage(imageName) {
  try {
    const { stdout } = await dockerExec("images", ["-q", imageName]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── helpers ─────────────────────────────────────────────

function dockerExec(subcommand, args) {
  return new Promise((res, rej) => {
    execFile("docker", [subcommand, ...args], (err, stdout, stderr) => {
      if (err) return rej(err);
      res({ stdout, stderr });
    });
  });
}
