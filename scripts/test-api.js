#!/usr/bin/env node

/**
 * 验证 API 配置是否正确，Claude Code 能否正常运行。
 *
 * 用法: node scripts/test-api.js
 */

import { loadConfig } from "../src/config.js";
import { checkDockerAvailable, checkDockerImage } from "../src/claude-runner.js";
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

  // 2. Docker 可用性
  const dockerOk = await checkDockerAvailable();
  if (!dockerOk) {
    console.error("  ✗ Docker 不可用，请确保 Docker 已安装并运行");
    process.exit(1);
  }
  console.log("  ✓ Docker 可用");

  // 3. 镜像存在
  const imageOk = await checkDockerImage(config.dockerImage);
  if (!imageOk) {
    console.error(
      `  ✗ Docker 镜像 "${config.dockerImage}" 不存在\n    请先执行: docker build -t ${config.dockerImage} .`,
    );
    process.exit(1);
  }
  console.log(`  ✓ 镜像 "${config.dockerImage}" 存在`);

  // 4. 准备工作区
  const sampleRepo = resolve(config.reposBaseDir, "sample-repo");
  let repoAbsPath;

  if (existsSync(sampleRepo)) {
    repoAbsPath = sampleRepo;
  } else {
    const tmpBase = mkdtempSync(resolve(tmpdir(), "cct-test-"));
    mkdirSync(resolve(tmpBase, "ws"), { recursive: true });
    repoAbsPath = resolve(tmpBase, "ws");
  }

  // 5. 执行最小 Claude Code 调用（直接 spawn docker，实时输出 stderr/stdout）
  const TIMEOUT_MS = 300_000; // 5 分钟：GLM 模型首次响应可能较慢
  console.log(`  → 执行最小 Claude Code 调用（最长等待 ${TIMEOUT_MS / 1000}s）...\n`);

  const containerName = `claude-test-api-${Date.now()}`;
  const dockerArgs = [
    "run", "--rm",
    "--name", containerName,
    "-v", `${repoAbsPath}:/workspace:ro`,
    "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
    ...(config.baseUrl ? ["-e", `ANTHROPIC_BASE_URL=${config.baseUrl}`] : []),
    ...(config.apiTimeoutMs ? ["-e", `API_TIMEOUT_MS=${config.apiTimeoutMs}`] : []),
    config.dockerImage,
    "-p",
    "--dangerously-skip-permissions",
    "--tools", config.allowedTools,
    "--no-session-persistence",
    "--output-format", "json",
    "--model", config.model,
    "Reply with exactly: OK",
  ];

  console.log("  [debug] docker", dockerArgs.map((a) => (a.includes("KEY") ? "***" : a)).join(" "));
  console.log();

  const result = await new Promise((res) => {
    const proc = spawn("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startTime = Date.now();

    proc.stdout.on("data", (d) => {
      const line = d.toString();
      stdout += line;
      // 实时打印容器 stdout，方便确认 Claude Code 正在工作
      process.stdout.write(`  [stdout] ${line}`);
    });
    proc.stderr.on("data", (d) => {
      const line = d.toString();
      stderr += line;
      // 实时打印容器 stderr，方便排查
      process.stderr.write(`  [stderr] ${line}`);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["stop", "-t", "3", containerName]);
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
    console.error(`\n  ✗ 超时（${TIMEOUT_MS / 1000}s）— Claude Code 容器无响应`);
    console.error("  可能原因：API Key 无效、BigModel 服务异常、或网络问题");
    console.error("\n  建议手动运行容器排查：");
    console.error(`    docker run --rm -it -e ANTHROPIC_API_KEY=<key> ${config.dockerImage} --version`);
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
