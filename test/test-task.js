#!/usr/bin/env node

/**
 * 端到端测试：向指定代码库发送提示词，接收 Claude Code 回复。
 *
 * 用法:
 *   node test/test-task.js                          # 使用默认 sample-repo + 默认提示词
 *   node test/test-task.js --repo sample-repo       # 指定代码库
 *   node test/test-task.js --prompt "列出所有函数"   # 指定提示词
 *   node test/test-task.js --repo my-project --prompt "分析错误处理"
 */

import { loadConfig } from "../src/config.js";
import { runClaude, checkDockerAvailable, checkDockerImage } from "../src/claude-runner.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo" && args[i + 1]) opts.repo = args[++i];
    else if (args[i] === "--prompt" && args[i + 1]) opts.prompt = args[++i];
    else if (args[i] === "--model" && args[i + 1]) opts.model = args[++i];
    else if (args[i] === "--timeout" && args[i + 1]) opts.timeout = parseInt(args[++i], 10);
  }
  return opts;
}

async function main() {
  const opts = parseArgs();

  const repo = opts.repo || "sample-repo";
  const prompt = opts.prompt || "阅读这个代码库，列出所有导出的函数，并简要说明每个函数的功能。";
  const model = opts.model || undefined;
  const timeoutMs = opts.timeout || 300_000;

  console.log("\n=== Claude Code Trees — 端到端任务测试 ===\n");

  const config = loadConfig({ envFile: ".env" });

  if (!config.apiKey) {
    console.error("  ✗ ANTHROPIC_API_KEY 未设置");
    process.exit(1);
  }

  if (!(await checkDockerAvailable())) {
    console.error("  ✗ Docker 不可用");
    process.exit(1);
  }

  if (!(await checkDockerImage(config.dockerImage))) {
    console.error(`  ✗ 镜像 "${config.dockerImage}" 不存在`);
    process.exit(1);
  }

  const task = {
    id: `test-${Date.now()}`,
    repoId: repo,
    prompt,
    model: model || config.model,
    timeoutMs,
  };

  console.log(`  代码库:  repos/${task.repoId}`);
  console.log(`  模型:    ${task.model}`);
  console.log(`  超时:    ${task.timeoutMs / 1000}s`);
  console.log(`  提示词:  ${task.prompt}`);
  console.log(`\n  → 启动 Claude Code 容器...\n`);

  const startTime = Date.now();

  const result = await runClaude(task, config, { workerId: "test" });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (result.timedOut) {
    console.error(`  ✗ 超时（${elapsed}s）`);
    if (result.stderr) console.error(`  stderr: ${result.stderr}`);
    process.exit(1);
  }

  if (result.exitCode !== 0) {
    console.error(`  ✗ 退出码: ${result.exitCode}（${elapsed}s）`);
    if (result.stderr) console.error(`  stderr: ${result.stderr}`);
    // Still try to show response if available
    if (result.stdout) {
      try {
        const json = JSON.parse(result.stdout);
        if (json.result) console.error(`\n  错误详情: ${json.result}`);
      } catch { /* ignore */ }
    }
    process.exit(1);
  }

  // Parse the JSON response
  let response;
  try {
    const json = JSON.parse(result.stdout);
    response = json.result || result.stdout;

    console.log("  ✓ 任务完成");
    console.log(`  ✓ 耗时: ${elapsed}s`);

    if (json.usage) {
      const u = json.usage;
      console.log(`  ✓ Token: 输入 ${u.input_tokens}, 输出 ${u.output_tokens}`);
    }
    if (json.total_cost_usd !== undefined) {
      console.log(`  ✓ 费用: $${json.total_cost_usd}`);
    }
  } catch {
    response = result.stdout;
    console.log(`  ✓ 完成（${elapsed}s）— 响应非 JSON 格式`);
  }

  console.log("\n" + "─".repeat(60));
  console.log("Claude Code 回复:");
  console.log("─".repeat(60) + "\n");
  console.log(response);
  console.log("\n" + "─".repeat(60) + "\n");
}

main().catch((err) => {
  console.error(`\n  ✗ 未预期错误: ${err.message}\n`);
  process.exit(1);
});
