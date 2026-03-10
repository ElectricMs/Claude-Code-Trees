#!/usr/bin/env node

/**
 * 绕开 Claude Code，直接向 BigModel Anthropic 兼容端点发送请求，
 * 验证 API Key 是否有效。
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env" });

const key = process.env.ANTHROPIC_API_KEY;
const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://open.bigmodel.cn/api/anthropic";
const url = `${baseUrl}/v1/messages`;

console.log("\n=== 直接测试 BigModel API ===\n");
console.log(`  端点: ${url}`);
console.log(`  Key:  ${key ? key.slice(0, 8) + "..." + key.slice(-4) : "(未设置)"}`);
console.log();

if (!key) {
  console.error("  ✗ ANTHROPIC_API_KEY 未设置");
  process.exit(1);
}

const body = {
  model: "glm-4.7",
  max_tokens: 32,
  messages: [{ role: "user", content: "Say OK" }],
};

console.log("  → 发送请求...\n");

try {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await resp.text();

  if (resp.ok) {
    console.log(`  ✓ 状态: ${resp.status}`);
    console.log(`  ✓ 响应: ${text.slice(0, 500)}`);
    console.log("\n=== API Key 有效 ===\n");
  } else {
    console.error(`  ✗ 状态: ${resp.status}`);
    console.error(`  ✗ 响应: ${text}`);
    console.error("\n=== API Key 认证失败 ===");
    console.error("  请检查:");
    console.error("    1. API Key 是否正确（在 open.bigmodel.cn 控制台查看）");
    console.error("    2. Key 是否已过期或被禁用");
    console.error("    3. 账户是否有 Anthropic 兼容 API 的访问权限\n");
  }
} catch (err) {
  console.error(`  ✗ 请求失败: ${err.message}\n`);
}
