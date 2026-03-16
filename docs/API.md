# Claude Code Trees — API 接口文档

服务默认地址：`http://localhost:3000`（可通过 `SERVER_HOST`、`SERVER_PORT` 配置）。

所有接口返回 JSON；成功时通常包含 `ok: true` 与 `data`，失败时包含 `ok: false` 与 `error`（错误信息字符串）。

---

## 1. 状态与配置

### GET `/api/status`

获取当前队列统计与所有 Worker 状态。

**请求**：无参数。

**响应**：`200 OK`

```json
{
  "ok": true,
  "data": {
    "queue": {
      "total": 10,
      "pending": 2,
      "running": 1,
      "completed": 5,
      "failed": 1,
      "cancelled": 1
    },
    "repos": 3,
    "workers": [
      {
        "id": 0,
        "status": "running",
        "taskId": "task-003",
        "taskPrompt": "分析代码中的安全漏洞",
        "elapsed": 45000
      },
      {
        "id": 1,
        "status": "idle",
        "taskId": null,
        "taskPrompt": null,
        "elapsed": null
      }
    ],
    "paused": false
  }
}
```

| 字段 | 说明 |
|------|------|
| `data.queue` | 任务队列统计：`total` 总数，`pending` 等待中，`running` 执行中，`completed` 已完成，`failed` 失败，`cancelled` 已取消 |
| `data.repos` | 已注册的代码库数量 |
| `data.workers` | Worker 列表，每项含 `id`、`status`（`idle` / `running` / `paused`）、`taskId`、`taskPrompt`、`elapsed`（已运行毫秒数，空闲时为 `null`） |
| `data.paused` | 是否已暂停 |

---

### GET `/api/config`

获取当前服务配置（只读）。

**请求**：无参数。

**响应**：`200 OK`

```json
{
  "ok": true,
  "data": {
    "model": "sonnet",
    "concurrency": 2,
    "timeoutMs": 300000,
    "dockerImage": "claude-code-sandbox",
    "allowedTools": "Read,Grep,Glob,LS"
  }
}
```

---

## 2. 代码库

代码库独立于任务管理，拥有自增 ID（`repo-001`, `repo-002`, ...），一个代码库可被多个任务引用。

### GET `/api/repos`

获取所有已注册的代码库列表。

**请求**：无参数。

**响应**：`200 OK`

```json
{
  "ok": true,
  "data": [
    {
      "id": "repo-001",
      "name": "my-project",
      "createdAt": "2026-03-10T08:00:00.000Z"
    }
  ]
}
```

---

### GET `/api/repos/:id`

获取单个代码库详情。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 代码库 ID，如 `repo-001` |

**响应**

- 成功：`200 OK`，`data` 为代码库对象（含 `id`、`name`、`path`、`createdAt`、文件列表等）。
- 不存在：`404`，`{ "ok": false, "error": "Repo not found" }`。

---

### POST `/api/repos`

上传代码库 ZIP 文件并注册。ZIP 会解压到 `repos/repo-NNN/`，系统自动分配 ID。

**请求**

- **Content-Type**：`multipart/form-data`
- **Body 字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | 代码库 ZIP 文件 |
| `name` | string | 否 | 代码库名称（默认使用 ZIP 文件名） |

**响应**

- 成功：`200 OK`

```json
{
  "ok": true,
  "data": {
    "id": "repo-001",
    "name": "my-project",
    "path": "repo-001",
    "createdAt": "2026-03-10T08:00:00.000Z"
  }
}
```

- 未上传文件：`400`，`{ "ok": false, "error": "ZIP file is required" }`。
- 解压失败：`500`，`{ "ok": false, "error": "错误信息" }`。

**示例**（curl）

```bash
curl -X POST http://localhost:3000/api/repos \
  -F "file=@/path/to/codebase.zip" \
  -F "name=my-project"
```

---

### DELETE `/api/repos/:id`

删除代码库及其磁盘文件。如果有 `pending` 或 `running` 状态的任务引用该代码库，则拒绝删除。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 代码库 ID |

**响应**

- 成功：`200 OK`，`{ "ok": true }`。
- 代码库不存在：`404`，`{ "ok": false, "error": "Repo not found" }`。
- 有活跃任务引用：`400`，`{ "ok": false, "error": "Cannot delete repo: active tasks reference it" }`。

---

## 3. 任务

### GET `/api/tasks`

获取任务列表。列表中每条任务的 `result` 会被截断为 `resultPreview`（最多 200 字符），完整结果需通过 `GET /api/tasks/:id` 获取。

**请求**：无参数。

**响应**：`200 OK`

```json
{
  "ok": true,
  "data": [
    {
      "id": "task-001",
      "prompt": "分析代码中的错误处理模式",
      "repoId": "repo-001",
      "model": null,
      "status": "completed",
      "createdAt": "2026-03-09T10:00:00.000Z",
      "startedAt": "2026-03-09T10:00:05.000Z",
      "completedAt": "2026-03-09T10:02:30.000Z",
      "durationMs": 145000,
      "resultPreview": "根据代码库分析，错误处理主要采用..."
    }
  ]
}
```

任务状态 `status` 取值：`pending`、`running`、`completed`、`failed`、`cancelled`。

---

### GET `/api/tasks/:id`

获取单个任务详情（含完整 `result`）。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务 ID，如 `task-001` |

**响应**

- 成功：`200 OK`，`data` 为完整任务对象（含 `result`、`error` 等）。
- 不存在：`404`，`{ "ok": false, "error": "Task not found" }`。

示例（已完成任务）：

```json
{
  "ok": true,
  "data": {
    "id": "task-001",
    "prompt": "分析代码中的错误处理模式",
    "repoId": "repo-001",
    "model": null,
    "status": "completed",
    "createdAt": "2026-03-09T10:00:00.000Z",
    "startedAt": "2026-03-09T10:00:05.000Z",
    "completedAt": "2026-03-09T10:02:30.000Z",
    "durationMs": 145000,
    "result": "完整的 Claude Code 分析输出（Markdown 或纯文本）..."
  }
}
```

---

### POST `/api/tasks`

创建任务：指定已有代码库的 ID + 提示词。

**请求**

- **Content-Type**：`application/json`
- **Body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 分析指令 / 提示词 |
| `repo_id` | string | 是 | 代码库 ID（如 `repo-001`） |
| `model` | string | 否 | 覆盖默认模型（如 `sonnet`、`opus`） |

**响应**

- 成功：`200 OK`，`data` 为创建的任务对象。
- 缺少 `prompt`：`400`，`{ "ok": false, "error": "prompt is required" }`。
- 缺少 `repo_id`：`400`，`{ "ok": false, "error": "repo_id is required" }`。
- 代码库不存在：`404`，`{ "ok": false, "error": "Repo not found: repo-999" }`。

**示例**

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "分析安全漏洞", "repo_id": "repo-001", "model": "opus"}'
```

---

### POST `/api/tasks/sse`

创建任务并异步执行。任务完成后，服务端自动将结果以 SSE 格式 POST 到回调地址 `{CALLBACK_BASE_URL}/api/v1/ai-stream-card/{user_id}`。

**请求**

- **Content-Type**：`application/json`
- **Body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `user_id` | string | 是 | 用户 ID，用于构建回调路径 |
| `prompt` | string | 是 | 分析指令 / 提示词 |
| `repo_id` | string | 是 | 代码库 ID |
| `model` | string | 否 | 覆盖默认模型 |

**响应**：`200 OK`，立即返回任务创建信息。

```json
{
  "ok": true,
  "data": {
    "id": "task-003",
    "status": "pending",
    "callbackUrl": "http://localhost:9000/api/v1/ai-stream-card/user-123"
  }
}
```

**回调投递**：任务完成后，服务端向回调地址发送：

```
POST /api/v1/ai-stream-card/{user_id}
Content-Type: text/event-stream

data: {"content":"完整分析结果..."}\n\n
```

**错误情况**

| HTTP 状态 | 错误码 | 说明 |
|-----------|--------|------|
| `400` | `MISSING_USER_ID` | 缺少 `user_id` |
| `400` | `MISSING_PROMPT` | 缺少 `prompt` |
| `400` | `MISSING_REPO_ID` | 缺少 `repo_id` |
| `404` | `REPO_NOT_FOUND` | 指定代码库不存在 |

**示例**

```bash
curl -X POST http://localhost:3000/api/tasks/sse \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-123", "prompt": "分析安全漏洞", "repo_id": "repo-001"}'
```

---

### POST `/api/tasks/sse2`

创建任务并保持 SSE 长连接，实时流式推送 Claude Code 的分析结果。任务通过 WorkerPool 队列调度，共享同一并发限制。

**请求**

- **Content-Type**：`application/json`
- **Body**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 分析指令 / 提示词 |
| `repo_id` | string | 是 | 代码库 ID |
| `model` | string | 否 | 覆盖默认模型 |

**响应**：`Content-Type: text/event-stream`，依次推送以下 SSE 事件：

1. **任务已创建**：
   ```
   data: {"type":"task_created","data":{"id":"task-001","prompt":"...","status":"pending",...}}
   ```

2. **内容流式推送**（Claude Code 产生输出时持续推送）：
   ```
   data: {"content":"分析结果的一段文本..."}
   ```

3. **完成（成功）**：
   ```
   data: {"type":"task_complete","ok":true,"data":{"id":"task-001","status":"completed","result":"完整结果",...}}
   ```

4. **完成（失败）**：
   ```
   data: {"type":"task_error","ok":false,"error":"错误信息","code":"TASK_FAILED","phase":"execution","taskId":"task-001"}
   ```

**错误码说明**

| 错误码 | 说明 |
|--------|------|
| `MISSING_PROMPT` | 缺少 prompt |
| `MISSING_REPO_ID` | 缺少 repo_id |
| `REPO_NOT_FOUND` | 代码库不存在 |
| `TASK_TIMEOUT` | 任务执行超时 |
| `TASK_FAILED` | 任务执行失败 |
| `INTERNAL_ERROR` | 服务端内部错误 |

**并发控制**：SSE 任务进入同一任务队列，受 `CONCURRENCY` 并发限制。如果所有 Worker 繁忙，任务排队等待。

**客户端断开**：取消 SSE 流式监听，任务本身继续执行完成，结果可通过 `GET /api/tasks/:id` 查看。

**示例**（curl）

```bash
curl -N -X POST http://localhost:3000/api/tasks/sse2 \
  -H "Content-Type: application/json" \
  -d '{"prompt": "分析安全漏洞", "repo_id": "repo-001"}'
```

**示例**（fetch）

```javascript
const res = await fetch("/api/tasks/sse2", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "分析安全漏洞", repo_id: "repo-001" }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value);
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const event = JSON.parse(line.slice(6));
      if (event.content) console.log(event.content);
      if (event.ok !== undefined) console.log("Done:", event);
    }
  }
}
```

---

### DELETE `/api/tasks/:id`

取消一条尚未开始执行的任务（仅 `pending` 可取消）。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务 ID |

**响应**

- 成功：`200 OK`，`{ "ok": true }`。
- 任务不存在或非 pending：`400`，`{ "ok": false, "error": "Can only cancel pending tasks" }`。

---

### POST `/api/tasks/:id/retry`

将已完成或失败的任务重新加入队列（状态重置为 `pending`，清空结果与错误信息）。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | string | 任务 ID |

**响应**

- 成功：`200 OK`，`data` 为重置后的任务对象。
- 任务不存在或状态不可重试：`400`，`{ "ok": false, "error": "Can only retry completed or failed tasks" }`。

---

## 4. Worker 控制

### POST `/api/workers/pause`

暂停所有 Worker：当前正在执行的任务会跑完，之后不再从队列取新任务。

**请求**：无 Body。

**响应**：`200 OK`，`{ "ok": true }`。

---

### POST `/api/workers/resume`

恢复 Worker，继续从队列取任务。

**请求**：无 Body。

**响应**：`200 OK`，`{ "ok": true }`。

---

### POST `/api/workers/:id/kill`

强制终止指定 Worker 当前运行的 Docker 容器（任务标记为失败）。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | Worker ID（从 0 开始） |

**响应**

- 成功：`200 OK`，`{ "ok": true }`。
- 该 Worker 未在运行或 ID 无效：`400`，`{ "ok": false, "error": "Worker not running or not found" }`。

---

### POST `/api/workers/kill-all`

强制终止所有正在运行任务的 Worker 的 Docker 容器。

**请求**：无 Body。

**响应**：`200 OK`，`{ "ok": true }`。

---

## 5. 运维

### POST `/api/purge`

清空所有运行数据：删除 `repos/` 目录下的所有代码库、`results/` 目录下的所有结果文件，清空任务队列和代码库注册表，将任务 ID 和代码库 ID 计数器归零。

如果有正在执行的任务（`running` 状态），将拒绝执行。

**请求**：无 Body。

**响应**

- 成功：`200 OK`

```json
{
  "ok": true,
  "message": "All data purged",
  "purged": {
    "repos": 5,
    "tasks": 12,
    "resultFiles": 8,
    "repoDirectories": 5
  }
}
```

- 有运行中的任务：`400`

```json
{
  "ok": false,
  "error": "Cannot purge while tasks are running"
}
```

---

## 6. 通用说明

- **Base URL**：默认 `http://localhost:3000`，部署时替换为实际 `SERVER_HOST:SERVER_PORT`。
- **CORS**：服务端已启用 CORS，前端可跨域请求。
- **错误格式**：业务错误均为 JSON，形如 `{ "ok": false, "error": "错误描述" }`，HTTP 状态码为 4xx/5xx。
- **任务 ID**：格式为 `task-001`、`task-002`，持久化在 `data/state.json`，重启后继续递增。
- **代码库 ID**：格式为 `repo-001`、`repo-002`，持久化在 `data/state.json`，重启后继续递增。
- **回调配置**：`/api/tasks/sse` 接口的回调地址由环境变量 `CALLBACK_BASE_URL` 控制，默认为 `http://localhost:{SERVER_PORT}`。
