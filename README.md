# Claude Code Trees

多 Claude Code 实例并行编排架构，支持在本地或服务器（如 EC2）中运行。每个实例在独立的 Docker 容器中以只读模式分析代码，通过共享持久化任务队列自动分配工作。提供 CLI 和 Web Dashboard 两种操控方式。

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│   CLI (index.js)              Web Dashboard (server.js)      │
│   add / import / run          POST /api/tasks (ZIP upload)   │
│   pause / resume / kill       POST /api/workers/pause ...    │
│   status                      GET  /api/status               │
│        │                              │                      │
│        └──────────┬───────────────────┘                      │
│                   ▼                                          │
│          ┌─────────────────┐                                 │
│          │  data/state.json │  ← 唯一持久化队列              │
│          │  (TaskQueue)     │                                 │
│          └────────┬────────┘                                 │
│                   ▼                                          │
│          ┌─────────────────┐     data/control.json           │
│          │   WorkerPool    │ ←── (pause / resume / stop)     │
│          │  worker 0..N    │                                 │
│          └───┬────┬────┬───┘                                 │
│              │    │    │                                      │
│          ┌───▼┐ ┌▼───┐ ┌▼───┐                               │
│          │ 🐳 │ │ 🐳 │ │ 🐳 │  Docker 容器 (:ro mount)      │
│          └────┘ └────┘ └────┘                                │
│                                                              │
│         repos/task-NNN/  ← 每个任务的代码库副本               │
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

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ANTHROPIC_API_KEY` | API 密钥（必填） | — |
| `ANTHROPIC_BASE_URL` | 自定义 API 端点（代理场景） | Anthropic 官方 |
| `CLAUDE_MODEL` | 默认模型 | `sonnet` |
| `CONCURRENCY` | 并行 worker 数量 | `2` |
| `TIMEOUT_MS` | 单任务超时 (ms) | `300000` |
| `REPOS_BASE_DIR` | 代码库基础目录 | `./repos` |
| `RESULTS_DIR` | 结果输出目录 | `./results` |
| `SERVER_PORT` | Web Dashboard 端口 | `3000` |
| `SERVER_HOST` | Web Dashboard 监听地址 | `0.0.0.0` |
| `DOCKER_IMAGE` | Docker 镜像名 | `claude-code-sandbox` |
| `DOCKER_MEMORY_LIMIT` | 容器内存限制（可选） | 无限制 |
| `ALLOWED_TOOLS` | Claude Code 可用工具 | `Read,Grep,Glob,LS` |

### 验证配置

```bash
npm run test:api
```

脚本会依次检查 .env 加载、API Key、Docker 可用性、镜像存在，并执行一次最小 Claude Code 调用。

---

## 使用方式一：CLI

CLI 提供完整的子命令来管理任务队列和 Worker：

### 添加任务

```bash
# 传入任意本地代码库路径 + 提示词，系统自动拷贝到 repos/task-NNN/
node src/index.js add --repo /path/to/my-project --prompt "分析代码中的安全漏洞"

# 使用相对路径
node src/index.js add --repo ../other-project --prompt "审查错误处理模式" --model opus
```

### 批量导入

创建 JSON 文件（参考 `import_example.json`）：

```json
{
  "tasks": [
    {
      "prompt": "分析错误处理模式，列出潜在问题和改进建议",
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
- **`prompt`**：内联提示词（需注意 JSON 转义：`"` → `\"`，换行用 `\n`）。
- **`promptFile`**：提示词文件路径（相对当前 JSON 文件所在目录），文件内容会整体作为 prompt。**适合上千字的长 prompt**，无需担心引号、换行破坏 JSON。

```bash
node src/index.js import --file import_example.json
```

`repo` 支持任意本地路径（绝对或相对），导入时自动拷贝。`id` 由系统自增生成，无需手动指定。

### 运行

```bash
# 启动 agent 消费队列中的 pending 任务，队列清空后自动退出
node src/index.js run

# 指定并发数
node src/index.js run --concurrency 4

# 指定模型和超时
node src/index.js run -m opus --timeout 600000
```

### 控制

```bash
# 暂停：所有 worker 完成当前任务后不再获取新任务
node src/index.js pause

# 恢复
node src/index.js resume

# 强制终止所有容器并停止 worker
node src/index.js kill --all

# 终止单个 worker 的容器
node src/index.js kill --worker 0
```

### 查看状态

```bash
node src/index.js status
```

输出队列统计（pending / running / completed / failed）和当前活跃的 Docker 容器列表。

### 使用 npm scripts

通过 `npm run cli` 调用 CLI 时，`--` 后的参数会原样传给脚本：

```bash
# 添加任务
npm run cli -- add --repo ./my-repo --prompt "分析代码"
npm run cli -- add --repo /path/to/project --prompt "安全审查" --model opus

# 批量导入
npm run cli -- import --file import_example.json

# 运行（消费队列直到清空）
npm run cli -- run
npm run cli -- run --concurrency 4 -m sonnet --timeout 600000

# 查看队列与容器状态
npm run cli -- status

# 控制 Worker（需有 run 或 serve 在跑）
npm run cli -- pause
npm run cli -- resume
npm run cli -- kill --all
npm run cli -- kill --worker 0
```

使用其他 `.env` 文件时加全局选项：

```bash
npm run cli -- --env-file .env.production run --concurrency 4
```

若已全局安装（`npm link` 或 `npm i -g .`），可直接执行：

```bash
claude-code-trees add --repo ./my-repo --prompt "分析代码"
claude-code-trees run --concurrency 4
```

---

## 使用方式二：Web Dashboard

Web Dashboard 提供可视化界面，支持任务管理、Agent 监控和远程连接。

### 启动

```bash
npm run serve
# 浏览器打开 http://localhost:3000
```

### 功能

- **添加任务**：上传 ZIP 格式代码库 + 提示词，支持选择模型
- **任务列表**：查看所有任务的状态（pending / running / completed / failed），点击查看 Markdown 格式的详细结果
- **Agent 监控**：实时查看每个 Worker 的运行状态、当前处理的任务、耗时
- **控制操作**：暂停全部 / 恢复全部 / 强制终止单个或全部 Worker / 重试任务
- **远程支持**：前端 API 地址可配置，支持连接远程部署的服务

### API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/status` | 队列统计 + Worker 状态 |
| `GET` | `/api/config` | 当前配置信息 |
| `GET` | `/api/tasks` | 任务列表（结果截断预览） |
| `GET` | `/api/tasks/:id` | 单个任务详情（含完整结果） |
| `POST` | `/api/tasks` | 创建任务（multipart: file + prompt） |
| `DELETE` | `/api/tasks/:id` | 取消 pending 任务 |
| `POST` | `/api/tasks/:id/retry` | 重试已完成/失败的任务 |
| `POST` | `/api/workers/pause` | 暂停所有 Worker |
| `POST` | `/api/workers/resume` | 恢复所有 Worker |
| `POST` | `/api/workers/:id/kill` | 强制终止指定 Worker |
| `POST` | `/api/workers/kill-all` | 强制终止所有 Worker |

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
│   ├── index.js              # CLI 入口（Commander 子命令）
│   ├── server.js             # Web Dashboard (Express)
│   ├── config.js             # 统一配置加载
│   ├── orchestrator.js       # run 命令核心逻辑（预检 + WorkerPool + 汇总）
│   ├── task-queue.js         # 持久化任务队列（data/state.json）
│   ├── worker-pool.js        # Worker 池管理（含控制文件轮询）
│   └── claude-runner.js      # Docker 容器生命周期管理
├── public/
│   └── index.html            # Web Dashboard 前端
├── scripts/
│   ├── test-api.js           # API + Docker + Claude Code 集成测试
│   ├── test-raw-api.js       # 裸 HTTP 请求测试 API Key 有效性
│   └── test-task.js          # 端到端任务执行测试
├── data/                     # 运行时数据（.gitignore）
│   ├── state.json            # 任务队列持久化存储
│   └── control.json          # CLI ↔ WorkerPool 控制信号
├── repos/                    # 代码库存放目录（每任务一份副本）
└── results/                  # 分析结果输出
```

## 数据流

1. **添加任务**（CLI `add` / Web Upload）：
   - 代码库被拷贝到 `repos/task-NNN/`（CLI 拷贝目录，Web 解压 ZIP）
   - 任务元数据写入 `data/state.json`，分配自增 ID（`task-001`, `task-002`, ...）
   - ID 跨重启持久化

2. **执行任务**（CLI `run` / Web 自动）：
   - WorkerPool 从队列 dequeue pending 任务
   - 启动 Docker 容器，只读挂载对应 `repos/task-NNN/`
   - Claude Code 在容器内分析代码，返回结果
   - 结果写入 `data/state.json` 并保存到 `results/task-NNN.json`

3. **控制**（CLI `pause`/`resume`/`kill` 或 Web API）：
   - CLI 通过写 `data/control.json` 文件传递指令
   - WorkerPool 每次循环轮询该文件，执行后删除
   - Web API 直接调用 WorkerPool 内存方法

## 安全模型

每次任务执行时，一个全新的 Docker 容器被创建：

```bash
docker run --rm \
  -v /path/to/repos/task-NNN:/workspace:ro \  # 只读挂载
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

| 场景 | 行为 |
|------|------|
| 容器超时 | SIGTERM → 10s 宽限 → SIGKILL，标记 `failed` |
| 容器非零退出 | 保存 stderr，标记 `failed` |
| repo 目录不存在 | `add` 时校验并报错；不会进入队列 |
| Docker 镜像不存在 | `run` / `serve` 启动时提示构建命令 |
| Ctrl+C | 停止取新任务，等待当前任务完成，清理容器 |
| 服务重启 | `data/state.json` 恢复队列，running 状态自动回退为 pending |

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
node scripts/test-raw-api.js
```

## License

MIT
