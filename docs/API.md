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
| `data.workers` | Worker 列表，每项含 `id`、`status`（`idle` / `running` / `paused`）、`taskId`、`taskPrompt`、`elapsed`（当前任务已运行毫秒数，空闲时为 `null`） |
| `data.paused` | 是否已暂停（Worker 完成当前任务后不再接新任务） |

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

| 字段 | 说明 |
|------|------|
| `model` | 默认 Claude 模型 |
| `concurrency` | 并行 Worker 数量 |
| `timeoutMs` | 单任务超时（毫秒） |
| `dockerImage` | 使用的 Docker 镜像名 |
| `allowedTools` | Claude Code 允许的工具列表 |

---

## 2. 任务

### GET `/api/tasks`

获取任务列表。列表中每条任务的 `result` 会被截断为最多 200 字符的 `resultPreview`，完整结果需通过 `GET /api/tasks/:id` 获取。

**请求**：无参数。

**响应**：`200 OK`

```json
{
  "ok": true,
  "data": [
    {
      "id": "task-001",
      "prompt": "分析代码中的错误处理模式",
      "repo": "task-001",
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
    "repo": "task-001",
    "model": null,
    "status": "completed",
    "createdAt": "2026-03-09T10:00:00.000Z",
    "startedAt": "2026-03-09T10:00:05.000Z",
    "completedAt": "2026-03-09T10:02:30.000Z",
    "durationMs": 145000,
    "result": "完整的 Claude Code 分析输出（可能为 Markdown 或纯文本）..."
  }
}
```

失败任务会包含 `error` 字段（字符串）。

---

### POST `/api/tasks`

通过 Web 创建任务：上传代码库 ZIP + 提示词。ZIP 会解压到 `repos/{task-id}/`，系统自动分配 `task-001`、`task-002` 等 ID。

**请求**

- **Content-Type**：`multipart/form-data`
- **Body 字段**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file | 是 | 代码库 ZIP 文件 |
| `prompt` | string | 是 | 分析指令 / 提示词 |
| `model` | string | 否 | 覆盖默认模型（如 `sonnet`、`opus`） |

**响应**

- 成功：`200 OK`，`data` 为刚创建的任务对象（同 `GET /api/tasks/:id` 结构）。
- 缺少 `prompt`：`400`，`{ "ok": false, "error": "prompt is required" }`。
- 未上传 ZIP：`400`，`{ "ok": false, "error": "ZIP file is required" }`。
- 解压或写入失败：`500`，`{ "ok": false, "error": "错误信息" }`。

**示例**（curl）

```bash
curl -X POST http://localhost:3000/api/tasks \
  -F "file=@/path/to/codebase.zip" \
  -F "prompt=分析该项目的安全漏洞" \
  -F "model=opus"
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

## 3. Worker 控制

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

强制终止指定 Worker 当前运行的 Docker 容器（任务会标记为失败或由超时逻辑处理）。

**路径参数**

| 参数 | 类型 | 说明 |
|------|------|------|
| `id` | number | Worker ID（从 0 开始，与 `/api/status` 中 `workers[].id` 一致） |

**响应**

- 成功：`200 OK`，`{ "ok": true }`。
- 该 Worker 未在运行或 ID 无效：`400`，`{ "ok": false, "error": "Worker not running or not found" }`。

---

### POST `/api/workers/kill-all`

强制终止所有正在运行任务的 Worker 的 Docker 容器。

**请求**：无 Body。

**响应**：`200 OK`，`{ "ok": true }`。

---

## 4. 通用说明

- **Base URL**：默认 `http://localhost:3000`，部署时替换为实际 `SERVER_HOST:SERVER_PORT`。
- **CORS**：服务端已启用 CORS，前端可跨域请求。
- **错误格式**：业务错误均为 JSON，形如 `{ "ok": false, "error": "错误描述" }`，HTTP 状态码为 4xx/5xx。
- **任务 ID**：由系统自增生成，格式为 `task-001`、`task-002`，持久化在 `data/state.json`，重启后继续递增。
