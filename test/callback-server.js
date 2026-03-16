#!/usr/bin/env node

/**
 * 简易回调监听服务，用于验证 /api/tasks/sse 的回调投递是否正确。
 *
 * 监听 http://localhost:9000，接收 POST /api/v1/ai-stream-card/{user_id}
 * 并将收到的 SSE 数据打印到控制台。
 *
 * 用法:
 *   node test/callback-server.js              # 默认端口 9000
 *   node test/callback-server.js --port 8080  # 自定义端口
 *
 * 配合使用:
 *   1. 在 .env 中设置 CALLBACK_BASE_URL=http://localhost:9000
 *   2. 启动本服务: npm run test:callback
 *   3. 启动主服务: npm run serve
 *   4. 调用 POST /api/tasks/sse 创建任务
 *   5. 观察本服务控制台输出
 */

import { createServer } from "node:http";

const port = (() => {
  const idx = process.argv.indexOf("--port");
  return idx !== -1 && process.argv[idx + 1]
    ? parseInt(process.argv[idx + 1], 10)
    : 9000;
})();

let requestCount = 0;

const server = createServer((req, res) => {
  const num = ++requestCount;
  const timestamp = new Date().toISOString();

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  #${num}  ${timestamp}`);
  console.log(`  ${req.method} ${req.url}`);
  console.log(`  Content-Type: ${req.headers["content-type"] || "(none)"}`);

  // Extract user_id from URL
  const match = req.url.match(/\/api\/v1\/ai-stream-card\/([^/?]+)/);
  if (match) {
    console.log(`  user_id: ${decodeURIComponent(match[1])}`);
  }

  let body = "";
  req.on("data", (chunk) => { body += chunk.toString(); });

  req.on("end", () => {
    console.log(`${"─".repeat(70)}`);

    if (!body) {
      console.log("  (empty body)");
    } else {
      // Parse SSE lines
      const lines = body.split("\n");
      let hasSSE = false;

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          hasSSE = true;
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            console.log("  ✓ SSE data received");
            if (data.content !== undefined) {
              const preview = data.content.length > 500
                ? data.content.slice(0, 500) + `... (${data.content.length} chars total)`
                : data.content;
              console.log(`  content: ${preview}`);
            } else {
              console.log(`  payload: ${JSON.stringify(data, null, 2)}`);
            }
          } catch {
            console.log(`  ✗ Invalid JSON in SSE data: ${jsonStr.slice(0, 200)}`);
          }
        }
      }

      if (!hasSSE) {
        console.log(`  Raw body (${body.length} bytes):`);
        console.log(`  ${body.slice(0, 1000)}`);
      }
    }

    // Validate expected format
    const contentType = req.headers["content-type"] || "";
    const isSSE = contentType.includes("text/event-stream");
    const isPost = req.method === "POST";
    const isCorrectPath = /\/api\/v1\/ai-stream-card\/.+/.test(req.url);

    console.log(`${"─".repeat(70)}`);
    console.log(`  Checks:`);
    console.log(`    ${isPost ? "✓" : "✗"} Method is POST (got: ${req.method})`);
    console.log(`    ${isCorrectPath ? "✓" : "✗"} Path matches /api/v1/ai-stream-card/{user_id}`);
    console.log(`    ${isSSE ? "✓" : "✗"} Content-Type is text/event-stream (got: ${contentType})`);
    console.log(`    ${body.includes("data: ") ? "✓" : "✗"} Body contains SSE data line`);
    console.log(`${"═".repeat(70)}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

server.listen(port, () => {
  console.log(`\n${"═".repeat(70)}`);
  console.log("  Claude Code Trees — SSE Callback Listener");
  console.log(`${"═".repeat(70)}`);
  console.log(`\n  Listening on http://localhost:${port}`);
  console.log(`  Waiting for POST /api/v1/ai-stream-card/{user_id} ...\n`);
  console.log("  Make sure .env has:");
  console.log(`    CALLBACK_BASE_URL=http://localhost:${port}\n`);
});
