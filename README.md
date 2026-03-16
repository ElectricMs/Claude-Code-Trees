# Claude Code Trees

多 Claude Code 实例并行编排架构，支持在本地或服务器（如 EC2）中运行。每个实例在独立的 Docker 容器中以只读模式分析代码，通过共享持久化任务队列自动分配工作。代码库独立管理、按需复用，任务通过引用代码库 ID 创建。CLI 管理任务队列，Web 服务由 HTTP API 统一控制 Worker 的执行、暂停、终止等操作。

代码和README.md未经严格审查。

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   CLI (index.js)              Web Server (server.js)         │
│   repo-add / add / import     POST /api/repos (ZIP upload)   │
│   repo-list / status / purge  POST /api/tasks (JSON)         │
│        │                      POST /api/workers/pause ...    │
│        │                              │                      │
│        └──────────┬───────────────────┘                      │
│                   ▼                                          │
│          ┌─────────────────┐                                 │
│          │  data/state.json │  ← 持久化队列 + 代码库注册表      │
│          │  (TaskQueue)     │                                │
│          └────────┬────────┘                                 │
│                   ▼                                          │
│          ┌─────────────────┐                                 │
│          │   WorkerPool    │ ← HTTP API 控制                  │
│          │  worker 0..N    │   (pause / resume / kill)       │
│          └───┬────┬────┬───┘                                 │
│              │    │    │                                     │
│          ┌───▼┐ ┌▼───┐ ┌▼───┐                                │
│          │ 🐳 │ │ 🐳 │ │ 🐳 │  Docker 容器 (:ro mount)         │
│          └────┘ └────┘ └────┘                                │
│                                                              │
│         repos/repo-NNN/  ← 独立管理的代码库（可被多任务复用）     │
└──────────────────────────────────────────────────────────────┘
```

**双重权限隔离**：

- **第一层 — Docker 容器**：文件系统硬隔离，代码库以 `:ro` 只读挂载，容器内无法看到宿主机其他文件
- **第二层 — 工具限制**：Claude Code 仅启用 `Read,Grep,Glob,LS` 只读工具集，无写入能力

## 快速开始

### 前置条件

- Node.js >= 18
- Docker 已安装并运行
- Anthropic API Key（或兼容的代理，如 BigModel/智谱AI）

### 安装

```bash
git clone <repo-url> claude-code-trees
cd claude-code-trees
npm install

# 构建 Docker 沙箱镜像
docker build -t claude-code-sandbox .

# 若 Docker Hub 不可达，可使用增量 Patch 构建（需本地已有基础镜像）：
npm run docker:build:patch
```

### 配置

```bash
cp .env.example .env
# 编辑 .env，填入 API Key 和其他配置
```

`.env` 关键配置项：


| 变量                    | 说明                           | 默认值                            |
| --------------------- | ---------------------------- | ------------------------------ |
| `ANTHROPIC_API_KEY`   | API 密钥（必填）                   | —                              |
| `ANTHROPIC_BASE_URL`  | 自定义 API 端点（代理场景）             | Anthropic 官方                   |
| `CLAUDE_MODEL`        | 默认模型                         | `sonnet`                       |
| `CONCURRENCY`         | 并行 worker 数量                 | `2`                            |
| `TIMEOUT_MS`          | 单任务超时 (ms)                   | `300000`                       |
| `REPOS_BASE_DIR`      | 代码库基础目录                      | `./repos`                      |
| `RESULTS_DIR`         | 结果输出目录                       | `./results`                    |
| `SERVER_PORT`         | Web Dashboard 端口             | `3000`                         |
| `SERVER_HOST`         | Web Dashboard 监听地址           | `0.0.0.0`                      |
| `DOCKER_IMAGE`        | Docker 镜像名                   | `claude-code-sandbox`          |
| `DOCKER_MEMORY_LIMIT` | 容器内存限制（可选）                   | 无限制                            |
| `ALLOWED_TOOLS`       | Claude Code 可用工具             | `Read,Grep,Glob,LS`            |
| `CALLBACK_BASE_URL`   | SSE 回调地址（`/api/tasks/sse` 用） | `http://localhost:SERVER_PORT` |


### 验证配置

```bash
npm run test:api
```

脚本会依次检查 .env 加载、API Key、Docker 可用性、镜像存在，并执行一次最小 Claude Code 调用。

---

## 核心概念

### 代码库与任务分离

项目将 **代码库（Repo）** 和 **任务（Task）** 解耦管理：

- **代码库**：独立上传和管理，拥有自增 ID（`repo-001`, `repo-002`, ...），存放在 `repos/` 目录下
- **任务**：引用已存在的代码库 ID，一个代码库可被多个任务复用

典型工作流：

```bash
# 1. 上传代码库（一次）
curl -F "file=@project.zip" -F "name=my-project" http://localhost:3000/api/repos
# → repo-001

# 2. 基于同一代码库创建多个分析任务
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "分析架构", "repo_id": "repo-001"}'

curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"prompt": "找出安全漏洞", "repo_id": "repo-001"}'
```

### Agent 概念

本项目中 **Agent** 指：由 WorkerPool 管理的**工作线程（Worker）**，每个 Worker 从任务队列取任务，并为每个任务启动一个 **Docker 容器**，在容器内运行 **Claude Code** 对代码库执行只读分析。

---

## CLI 工具

CLI 用于管理代码库和任务队列（添加 / 批量导入 / 查看状态 / 清空数据），不负责执行任务。执行和控制统一通过 [Web 服务](#web-服务与-dashboard) 的 HTTP API 完成。

### 代码库管理

```bash
# 从本地目录添加代码库
node src/index.js repo-add --path /path/to/my-project --name "My Project"

# 查看已注册的代码库列表
node src/index.js repo-list
```

### 添加任务

```bash
# 引用已有代码库 ID
node src/index.js add --repo repo-001 --prompt "分析代码中的安全漏洞"

# 也可直接传本地路径（自动创建代码库后创建任务）
node src/index.js add --repo /path/to/my-project --prompt "审查错误处理模式" --model opus
```

### 批量导入

创建 JSON 文件（参考 `import_example.json`）：

```json
{
  "tasks": [
    {
      "prompt": "分析错误处理模式",
      "repo": "./repos/sample-repo"
    },
    {
      "promptFile": "prompts/review.md",
      "repo": "/absolute/path/to/another-project"
    }
  ]
}
```

每条任务二选一：

- `**prompt**`：内联提示词。
- `**promptFile**`：提示词文件路径（相对 JSON 文件所在目录），适合长 prompt。

```bash
node src/index.js import --file import_example.json
```

`repo` 支持任意本地路径（绝对或相对），导入时自动创建代码库并拷贝文件。

### 查看状态

```bash
node src/index.js status
```

输出队列统计（pending / running / completed / failed）、代码库数量和当前活跃的 Docker 容器列表。

### 清空数据

```bash
# 交互式确认
node src/index.js purge

# 跳过确认（脚本/CI 用）
node src/index.js purge --force
```

删除所有代码库、结果文件，清空任务队列，将代码库序号和任务序号均重置为 1。

### 使用 npm scripts

```bash
# 代码库管理
npm run cli -- repo-add --path ./my-repo --name "My Repo"
npm run cli -- repo-list

# 添加任务
npm run cli -- add --repo repo-001 --prompt "分析代码"
npm run cli -- add --repo /path/to/project --prompt "安全审查" --model opus

# 批量导入
npm run cli -- import --file import_example.json

# 查看状态
npm run cli -- status

# 清空数据
npm run cli -- purge --force
```

---

## Web 服务与 Dashboard

执行 `npm run serve` 启动 HTTP 服务，同时启动 Worker 池，后台持续处理队列中的任务。

### 启动

```bash
npm run serve
# 浏览器打开 http://localhost:3000
```

### API 接口总览

#### 代码库


| 方法       | 路径               | 说明                                       |
| -------- | ---------------- | ---------------------------------------- |
| `GET`    | `/api/repos`     | 获取代码库列表                                  |
| `GET`    | `/api/repos/:id` | 获取代码库详情                                  |
| `POST`   | `/api/repos`     | 上传代码库 ZIP（multipart: `file` + 可选 `name`） |
| `DELETE` | `/api/repos/:id` | 删除代码库（有活跃任务引用时拒绝）                        |


#### 任务


| 方法       | 路径                     | 说明                               |
| -------- | ---------------------- | -------------------------------- |
| `GET`    | `/api/tasks`           | 任务列表（结果截断预览）                     |
| `GET`    | `/api/tasks/:id`       | 单个任务详情（含完整结果）                    |
| `POST`   | `/api/tasks`           | 创建任务（JSON: `prompt` + `repo_id`） |
| `POST`   | `/api/tasks/sse`       | 创建任务，完成后回调投递结果                   |
| `POST`   | `/api/tasks/sse2`      | 创建任务，SSE 流式返回结果                  |
| `DELETE` | `/api/tasks/:id`       | 取消 pending 任务                    |
| `POST`   | `/api/tasks/:id/retry` | 重试已完成/失败的任务                      |


#### Worker 控制


| 方法     | 路径                      | 说明            |
| ------ | ----------------------- | ------------- |
| `POST` | `/api/workers/pause`    | 暂停所有 Worker   |
| `POST` | `/api/workers/resume`   | 恢复所有 Worker   |
| `POST` | `/api/workers/:id/kill` | 强制终止指定 Worker |
| `POST` | `/api/workers/kill-all` | 强制终止所有 Worker |


#### 运维


| 方法     | 路径            | 说明               |
| ------ | ------------- | ---------------- |
| `GET`  | `/api/status` | 队列统计 + Worker 状态 |
| `GET`  | `/api/config` | 当前配置信息           |
| `POST` | `/api/purge`  | 清空所有数据并重置序号      |


### SSE 回调接口：POST `/api/tasks/sse`

创建任务后**立即返回** JSON。任务在后台异步处理，完成后自动将结果以 SSE 格式 POST 到回调地址。

**请求**（JSON）：

```json
{
  "user_id": "user-123",
  "prompt": "分析代码中的安全漏洞",
  "repo_id": "repo-001",
  "model": "sonnet"
}
```

**响应**：`200 OK`，立即返回任务信息。

**回调投递**：任务完成后，服务端自动 POST 到 `{CALLBACK_BASE_URL}/api/v1/ai-stream-card/{user_id}`：

```
POST /api/v1/ai-stream-card/user-123
Content-Type: text/event-stream

data: {"content":"完整分析结果..."}\n\n
```

**调用示例**：

```bash
curl -X POST http://localhost:3000/api/tasks/sse \
  -H "Content-Type: application/json" \
  -d '{"user_id": "user-123", "prompt": "分析安全漏洞", "repo_id": "repo-001"}'
```

### SSE 流式接口：POST `/api/tasks/sse2`

创建任务并保持 SSE 连接，实时流式推送 Claude Code 的分析结果。

**请求**（JSON）：

```json
{
  "prompt": "分析代码中的安全漏洞",
  "repo_id": "repo-001",
  "model": "sonnet"
}
```

**SSE 事件格式**：

1. **任务已创建**：`data: {"type":"task_created","data":{...}}`
2. **内容流式推送**：`data: {"content":"分析结果的一段文本..."}`
3. **完成**：`data: {"type":"task_complete","ok":true,"data":{...}}`
4. **失败**：`data: {"type":"task_error","ok":false,"error":"...","code":"TASK_FAILED",...}`

**调用示例**：

```bash
curl -N -X POST http://localhost:3000/api/tasks/sse2 \
  -H "Content-Type: application/json" \
  -d '{"prompt": "分析安全漏洞", "repo_id": "repo-001"}'
```

---

## 项目结构

```
claude-code-trees/
├── .env.example              # 配置模板
├── Dockerfile                # Claude Code 沙箱镜像
├── Dockerfile.patch          # 增量构建（基于本地已有镜像）
├── docker-entrypoint.sh      # 容器启动脚本（动态生成 settings.json）
├── import_example.json       # 批量导入示例
├── package.json
├── src/
│   ├── index.js              # CLI 入口（repo-add / repo-list / add / import / status / purge）
│   ├── server.js             # Web 服务 + HTTP API (Express)
│   ├── config.js             # 统一配置加载
│   ├── task-queue.js         # 持久化任务队列 + 代码库注册表（data/state.json）
│   ├── worker-pool.js        # Worker 池管理（HTTP API 控制）
│   └── claude-runner.js      # Docker 容器生命周期管理
├── public/
│   └── index.html            # Web Dashboard 前端
├── test/
│   ├── test-api.js           # API + Docker + Claude Code 集成测试
│   ├── test-raw-api.js       # 裸 HTTP 请求测试 API Key 有效性
│   ├── test-task.js          # 端到端任务执行测试
│   └── callback-server.js    # SSE 回调监听测试服务（端口 9000）
├── docs/
│   ├── API.md                # API 接口文档
│   └── openapi.yaml          # OpenAPI 3.0 规范
├── data/                     # 运行时数据（.gitignore）
│   └── state.json            # 任务队列 + 代码库注册表持久化
├── repos/                    # 代码库存放目录（repo-001/, repo-002/, ...）
└── results/                  # 分析结果输出
```

## 数据流

1. **上传代码库**（CLI `repo-add` / API `POST /api/repos`）：
  - 代码库被拷贝/解压到 `repos/repo-NNN/`
  - 代码库元数据注册到 `data/state.json`，分配自增 ID（`repo-001`, `repo-002`, ...）
2. **创建任务**（CLI `add` / API `POST /api/tasks`）：
  - 任务引用已有代码库 ID，写入 `data/state.json`
  - 任务分配自增 ID（`task-001`, `task-002`, ...）
3. **执行任务**（`npm run serve` 启动服务后自动处理）：
  - WorkerPool 从队列 dequeue pending 任务
  - 启动 Docker 容器，只读挂载对应 `repos/repo-NNN/`
  - Claude Code 在容器内分析代码，返回结果
  - 结果写入 `data/state.json` 并保存到 `results/task-NNN.json`
4. **控制**（HTTP API / Dashboard）：
  - 通过 HTTP API 直接调用 WorkerPool 内存方法（pause / resume / kill）
  - Dashboard 提供可视化操作界面

## 安全模型

每次任务执行时，一个全新的 Docker 容器被创建：

```bash
docker run --rm \
  -v /path/to/repos/repo-NNN:/workspace:ro \  # 只读挂载
  -e ANTHROPIC_API_KEY=xxx \                   # 运行时注入，不写入镜像
  claude-code-sandbox \
  -p --dangerously-skip-permissions \
  --allowedTools "Read,Grep,Glob,LS" \         # 仅只读工具
  "分析指令..."
```

- 代码库以 `:ro` 挂载 — 文件系统层面强制只读
- `--allowedTools` 限制为只读工具集 — Claude Code 层面无写入能力
- `--rm` 容器退出即销毁 — 零残留
- API Key 通过 `-e` 注入 — 不写入镜像或磁盘
- 非 root 用户运行 — 满足 Claude Code 安全要求
- `--dangerously-skip-permissions` 仅在容器沙箱内使用

## 错误处理


| 场景           | 行为                                             |
| ------------ | ---------------------------------------------- |
| 容器超时         | SIGTERM → 10s 宽限 → SIGKILL，标记 `failed`         |
| 容器非零退出       | 保存 stderr，标记 `failed`                          |
| 代码库不存在       | 创建任务时校验并报错                                     |
| Docker 镜像不存在 | `serve` 启动时提示构建命令                              |
| Ctrl+C       | 停止取新任务，等待当前任务完成，清理容器                           |
| 服务重启         | `data/state.json` 恢复队列，running 状态自动回退为 pending |


## 故障排除

### Docker 构建失败：`failed to fetch anonymous token` / `EOF`

无法访问 Docker Hub（网络受限）。可选方案：

1. **使用增量 Patch 构建**（需本地已有基础镜像）：
  ```bash
   npm run docker:build:patch
  ```
2. **配置 Docker 镜像加速**：Docker Desktop → Settings → Docker Engine 中添加 `registry-mirrors`

### BigModel（智谱AI）代理配置

使用 BigModel 作为 API 代理时，在 `.env` 中配置：

```bash
ANTHROPIC_API_KEY=your_zhipu_api_key
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
API_TIMEOUT_MS=3000000
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-4.7
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5
```

容器内 `docker-entrypoint.sh` 会自动将这些变量写入 `~/.claude/settings.json`。

### API Key 验证失败（401）

使用裸 HTTP 请求测试，排除 Docker 和 Claude Code 的干扰：

```bash
node test/test-raw-api.js
```

### 测试 SSE 回调

使用内置的回调监听服务验证 `/api/tasks/sse` 是否正确投递结果：

```bash
# 终端 1：启动回调监听（端口 9000）
npm run test:callback

# 终端 2：启动主服务（.env 中设置 CALLBACK_BASE_URL=http://localhost:9000）
npm run serve

# 终端 3：创建任务
curl -X POST http://localhost:3000/api/tasks/sse \
  -H "Content-Type: application/json" \
  -d '{"user_id":"test","prompt":"分析架构","repo_id":"repo-001"}'
```

