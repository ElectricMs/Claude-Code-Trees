import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load .env, merge with CLI options, validate required fields,
 * and return a frozen configuration object.
 *
 * Priority (low → high): .env → task-level overrides → CLI options
 */
export function loadConfig(cliOpts = {}) {
  dotenvConfig({ path: cliOpts.envFile || ".env" });

  const projectRoot = process.cwd();

  const reposBaseDir = resolve(
    projectRoot,
    cliOpts.reposBaseDir || process.env.REPOS_BASE_DIR || "./repos",
  );
  const resultsDir = resolve(
    projectRoot,
    cliOpts.output || process.env.RESULTS_DIR || "./results",
  );

  const config = Object.freeze({
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "",
    model: cliOpts.model || process.env.CLAUDE_MODEL || "sonnet",
    concurrency: parseInt(
      cliOpts.concurrency || process.env.CONCURRENCY || "2",
      10,
    ),
    timeoutMs: parseInt(
      cliOpts.timeout || process.env.TIMEOUT_MS || "300000",
      10,
    ),
    reposBaseDir,
    resultsDir,
    dockerImage:
      cliOpts.dockerImage || process.env.DOCKER_IMAGE || "claude-code-sandbox",
    dockerMemoryLimit: process.env.DOCKER_MEMORY_LIMIT || "",
    allowedTools: process.env.ALLOWED_TOOLS || "Read,Grep,Glob,LS",
    // API_TIMEOUT_MS for proxies like BigModel that need longer timeouts
    apiTimeoutMs: process.env.API_TIMEOUT_MS || "",
    // Base URL for the callback endpoint used by /api/tasks/sse
    callbackBaseUrl: process.env.CALLBACK_BASE_URL || "",
  });

  return config;
}

/**
 * Validate the configuration; throws on fatal errors.
 */
export function validateConfig(config) {
  const errors = [];

  if (!config.apiKey) {
    errors.push(
      "ANTHROPIC_API_KEY is required. Set it in .env or as an environment variable.",
    );
  }
  if (!existsSync(config.reposBaseDir)) {
    errors.push(`REPOS_BASE_DIR does not exist: ${config.reposBaseDir}`);
  }
  if (config.concurrency < 1 || config.concurrency > 20) {
    errors.push(
      `CONCURRENCY must be between 1 and 20, got ${config.concurrency}`,
    );
  }
  if (config.timeoutMs < 10_000) {
    errors.push(
      `TIMEOUT_MS must be at least 10000 (10s), got ${config.timeoutMs}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Configuration errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
    );
  }
}
