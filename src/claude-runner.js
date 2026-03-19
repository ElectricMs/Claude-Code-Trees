import { spawn, execFile } from "node:child_process";
import { resolve } from "node:path";

// ── System prompt (user prompt injected via {{USER_PROMPT}}) ─────

const PLACEHOLDER_USER_PROMPT = "{{USER_PROMPT}}";

const APPEND_SYSTEM_PROMPT_TEMPLATE = `你是一个代码库分析助手。本次会话请严格遵循以下要求。

【任务要点】
- 只读：仅可读取、搜索、列举代码与文件，不得修改、写入、删除任何文件或执行会改变系统的命令或创建测试代码。
- 分析：对代码库进行结构化分析（如架构、依赖、关键逻辑、潜在问题）。
- 给出修改意见：以文字形式给出改进建议、修复方案或优化思路，不直接改代码。

【注意事项】
- 回复使用**中文**。
- 结论需有依据，**引用具体文件或代码位置**。
- 若信息不足无法判断，请明确说明并指出需要补充的内容。

用户本次任务：${PLACEHOLDER_USER_PROMPT}
请时刻牢记注意事项回答。`;

function buildAppendSystemPrompt(userPrompt) {
  const safe = userPrompt != null ? String(userPrompt).trim() : "";
  return APPEND_SYSTEM_PROMPT_TEMPLATE.replace(PLACEHOLDER_USER_PROMPT, safe);
}

// ── Shared helpers ──────────────────────────────────────

/** Print-mode user message: trigger execution per system prompt. */
const PRINT_MODE_USER_MESSAGE = "请根据系统提示中的用户任务要求执行分析并回复。";

function buildClaudeArgs(task, config, outputFormat) {
  const model = task.model || config.model;
  const appendPrompt = buildAppendSystemPrompt(task.prompt);
  return [
    "--append-system-prompt",
    appendPrompt,
    "-p",
    "--dangerously-skip-permissions",
    "--tools",
    config.allowedTools,
    "--no-session-persistence",
    "--output-format",
    outputFormat,
    "--model",
    model,
    PRINT_MODE_USER_MESSAGE,
  ];
}

function buildNativeEnv(config) {
  const env = { ...process.env, ANTHROPIC_API_KEY: config.apiKey };
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  if (config.apiTimeoutMs) env.API_TIMEOUT_MS = config.apiTimeoutMs;
  return env;
}

/**
 * Parse a command string like "npx @anthropic-ai/claude-code" into
 * { command, prefixArgs } for spawn.
 */
function parseCmd(cmdStr) {
  const parts = cmdStr.trim().split(/\s+/);
  return { command: parts[0], prefixArgs: parts.slice(1) };
}

/**
 * Gracefully kill a native child process: SIGTERM then SIGKILL after delay.
 */
function killNativeProc(proc, graceSec = 10) {
  return new Promise((res) => {
    if (!proc || proc.exitCode !== null) return res();
    proc.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, graceSec * 1000);
    proc.once("close", () => {
      clearTimeout(forceTimer);
      res();
    });
  });
}

// ── Docker helpers ──────────────────────────────────────

function dockerExec(subcommand, args) {
  return new Promise((res, rej) => {
    execFile("docker", [subcommand, ...args], (err, stdout, stderr) => {
      if (err) return rej(err);
      res({ stdout, stderr });
    });
  });
}

function buildDockerArgs(task, config, containerName) {
  const repoAbsPath = resolve(config.reposBaseDir, task.repoId);
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-v",
    `${repoAbsPath}:/workspace:ro`,
    "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
  ];
  if (config.baseUrl) {
    args.push("-e", `ANTHROPIC_BASE_URL=${config.baseUrl}`);
  }
  if (config.apiTimeoutMs) {
    args.push("-e", `API_TIMEOUT_MS=${config.apiTimeoutMs}`);
  }
  if (config.dockerMemoryLimit) {
    args.push("--memory", config.dockerMemoryLimit);
  }
  args.push(config.dockerImage);
  return args;
}

// ── runClaude ───────────────────────────────────────────

/**
 * Run a Claude Code analysis.
 *
 * In Docker mode the repo is mounted read-only at /workspace inside a container.
 * In Native mode Claude Code runs directly on the host with cwd set to the repo.
 *
 * Returns { exitCode, stdout, stderr, durationMs, timedOut, containerName }.
 * containerName is null in native mode.
 */
export function runClaude(task, config, { workerId, signal } = {}) {
  if (config.agentMode === "native") {
    return runClaudeNative(task, config, { workerId, signal, outputFormat: "json" });
  }
  return runClaudeDocker(task, config, { workerId, signal, outputFormat: "json" });
}

/**
 * Run Claude Code with streaming output (stream-json).
 *
 * The `onData(line)` callback is invoked for each complete JSON line from stdout.
 * Returns the same shape as runClaude.
 */
export function runClaudeStreaming(task, config, { workerId, signal, onData } = {}) {
  if (config.agentMode === "native") {
    return runClaudeNative(task, config, { workerId, signal, outputFormat: "stream-json", onData });
  }
  return runClaudeDocker(task, config, { workerId, signal, outputFormat: "stream-json", onData });
}

// ── Docker implementation ───────────────────────────────

function runClaudeDocker(task, config, { workerId, signal, outputFormat, onData } = {}) {
  return new Promise((resolveP, rejectP) => {
    const containerName = `claude-${workerId}-${task.id}`.replace(
      /[^a-zA-Z0-9_.-]/g,
      "-",
    );
    const timeoutMs = task.timeoutMs || config.timeoutMs;

    const dockerArgs = [
      ...buildDockerArgs(task, config, containerName),
      ...buildClaudeArgs(task, config, outputFormat),
    ];

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

// ── Native implementation ───────────────────────────────

function runClaudeNative(task, config, { workerId, signal, outputFormat, onData } = {}) {
  return new Promise((resolveP, rejectP) => {
    const repoAbsPath = resolve(config.reposBaseDir, task.repoId);
    const timeoutMs = task.timeoutMs || config.timeoutMs;
    const claudeArgs = buildClaudeArgs(task, config, outputFormat);
    const { command, prefixArgs } = parseCmd(config.nativeClaudeCmd);

    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let lineBuf = "";

    const proc = spawn(command, [...prefixArgs, ...claudeArgs], {
      cwd: repoAbsPath,
      env: buildNativeEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
    });

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
        containerName: null,
      });
    };

    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectP(err);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killNativeProc(proc, 10);
    }, timeoutMs);

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          if (!settled) killNativeProc(proc, 5);
        },
        { once: true },
      );
    }
  });
}

// ── Public utilities ────────────────────────────────────

/**
 * Force-remove a Docker container by name (best-effort cleanup).
 * Safe to call with null (native mode) — returns immediately.
 */
export function forceRemoveContainer(containerName) {
  if (!containerName) return Promise.resolve();
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
 */
export async function checkDockerImage(imageName) {
  try {
    const { stdout } = await dockerExec("images", ["-q", imageName]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Check that a native claude command is available on the host.
 */
export async function checkNativeClaudeAvailable(nativeClaudeCmd) {
  const { command } = parseCmd(nativeClaudeCmd);
  return new Promise((res) => {
    execFile("which", [command], (err) => res(!err));
  });
}
