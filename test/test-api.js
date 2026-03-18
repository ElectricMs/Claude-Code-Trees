#!/usr/bin/env node

/**
 * 验证 API 配置是否正确，Claude Code 能否正常运行。
 *
 * 用法: node test/test-api.js
 */

import { loadConfig } from "../src/config.js";
import { checkDockerAvailable, checkDockerImage, checkNativeClaudeAvailable } from "../src/claude-runner.js";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

async function main() {
  console.log("\n=== Claude Code Trees — API 配置测试 ===\n");

  // 1. 加载配置
  let config;
  try {
    config = loadConfig({ envFile: ".env" });
    console.log("  ✓ .env 加载成功");
  } catch (err) {
    console.error("  ✗ .env 加载失败:", err.message);
    process.exit(1);
  }

  if (!config.apiKey) {
    console.error("  ✗ ANTHROPIC_API_KEY 未设置，请在 .env 中配置");
    process.exit(1);
  }
  console.log("  ✓ API Key 已配置");

  console.log(`  Agent 模式: ${config.agentMode}`);

  // 2. 环境检查（按 agentMode 分支）
  const sampleRepo = resolve(config.reposBaseDir, "sample-repo");
  let repoAbsPath;
  if (existsSync(sampleRepo)) {
    repoAbsPath = sampleRepo;
  } else {
    const tmpBase = mkdtempSync(resolve(tmpdir(), "cct-test-"));
    mkdirSync(resolve(tmpBase, "ws"), { recursive: true });
    repoAbsPath = resolve(tmpBase, "ws");
  }

  const TIMEOUT_MS = 300_000;
  const claudeCliArgs = [
    "-p",
    "--dangerously-skip-permissions",
    "--tools", config.allowedTools,
    "--no-session-persistence",
    "--output-format", "json",
    "--model", config.model,
    "Reply with exactly: OK",
  ];

  let spawnCmd, spawnArgs, spawnOpts, killFn, debugLabel;

  if (config.agentMode === "docker") {
    const dockerOk = await checkDockerAvailable();
    if (!dockerOk) {
      console.error("  ✗ Docker 不可用，请确保 Docker 已安装并运行");
      process.exit(1);
    }
    console.log("  ✓ Docker 可用");

    const imageOk = await checkDockerImage(config.dockerImage);
    if (!imageOk) {
      console.error(
        `  ✗ Docker 镜像 "${config.dockerImage}" 不存在\n    请先执行: docker build -t ${config.dockerImage} .`,
      );
      process.exit(1);
    }
    console.log(`  ✓ 镜像 "${config.dockerImage}" 存在`);

    const containerName = `claude-test-api-${Date.now()}`;
    spawnCmd = "docker";
    spawnArgs = [
      "run", "--rm",
      "--name", containerName,
      "-v", `${repoAbsPath}:/workspace:ro`,
      "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
      ...(config.baseUrl ? ["-e", `ANTHROPIC_BASE_URL=${config.baseUrl}`] : []),
      ...(config.apiTimeoutMs ? ["-e", `API_TIMEOUT_MS=${config.apiTimeoutMs}`] : []),
      config.dockerImage,
      ...claudeCliArgs,
    ];
    spawnOpts = { stdio: ["ignore", "pipe", "pipe"] };
    killFn = () => spawn("docker", ["stop", "-t", "3", containerName]);
    debugLabel = `docker ${spawnArgs.map((a) => (a.includes("KEY") ? "***" : a)).join(" ")}`;
  } else {
    const cmdOk = await checkNativeClaudeAvailable(config.nativeClaudeCmd);
    if (!cmdOk) {
      console.error(`  ✗ Native 命令 "${config.nativeClaudeCmd}" 不在 PATH 中`);
      console.error("    请先安装: npm install -g @anthropic-ai/claude-code");
      process.exit(1);
    }
    console.log(`  ✓ Native 命令 "${config.nativeClaudeCmd}" 可用`);

    const parts = config.nativeClaudeCmd.trim().split(/\s+/);
    spawnCmd = parts[0];
    spawnArgs = [...parts.slice(1), ...claudeCliArgs];
    const env = { ...process.env, ANTHROPIC_API_KEY: config.apiKey };
    if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
    if (config.apiTimeoutMs) env.API_TIMEOUT_MS = config.apiTimeoutMs;
    spawnOpts = { cwd: repoAbsPath, env, stdio: ["ignore", "pipe", "pipe"] };
    killFn = null;
    debugLabel = `${config.nativeClaudeCmd} ${claudeCliArgs.join(" ")}`;
  }

  console.log(`  → 执行最小 Claude Code 调用（最长等待 ${TIMEOUT_MS / 1000}s）...\n`);
  console.log(`  [debug] ${debugLabel}`);
  console.log();

  const result = await new Promise((res) => {
    const proc = spawn(spawnCmd, spawnArgs, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startTime = Date.now();

    proc.stdout.on("data", (d) => {
      const line = d.toString();
      stdout += line;
      process.stdout.write(`  [stdout] ${line}`);
    });
    proc.stderr.on("data", (d) => {
      const line = d.toString();
      stderr += line;
      process.stderr.write(`  [stderr] ${line}`);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (killFn) killFn();
      else proc.kill("SIGTERM");
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      res({ exitCode: code ?? 1, stdout, stderr, timedOut, durationMs: Date.now() - startTime });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      res({ exitCode: -1, stdout, stderr: err.message, timedOut: false, durationMs: Date.now() - startTime });
    });
  });

  if (result.timedOut) {
    console.error(`\n  ✗ 超时（${TIMEOUT_MS / 1000}s）— Claude Code 无响应`);
    console.error("  可能原因：API Key 无效、BigModel 服务异常、或网络问题");
    if (config.agentMode === "docker") {
      console.error(`    docker run --rm -it -e ANTHROPIC_API_KEY=<key> ${config.dockerImage} --version`);
    }
    process.exit(1);
  }

  if (result.exitCode !== 0) {
    console.error(`\n  ✗ Claude Code 返回非零退出码: ${result.exitCode}`);
    if (result.stderr) console.error("  stderr:", result.stderr);
    process.exit(1);
  }

  console.log("\n  ✓ Claude Code 调用成功");
  console.log(`  ✓ 耗时: ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log("\n=== 测试通过 ===\n");
}

main();
