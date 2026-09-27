# 架构与运行

> 本文记录仓库**已经实现的行为**。项目目标和未完成的 M1 验收见 [GOALS.md](./GOALS.md)，取舍见 [DESIGN.md](./DESIGN.md)，安全边界见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

## 1. 当前结构

运行时为 Node.js ESM。`openai` SDK 只承担 Chat Completions 网络请求，`dotenv` 为 CLI 加载本地配置，Zod 校验工具参数并转换 JSON Schema；Agent 循环由本仓库实现，测试使用 `node:test`。

```text
src/
  index.js                  CLI：配置、权限选择、进度与最终状态
  eval.js                   真实模型固定测评入口
  agent/runAgent.js         单 Agent 工具调用循环及运行事件
  evals/                    固定任务、工作区准备、检查器与测评运行器
  model/openaiCompatible.js OpenAI 兼容 Chat Completions 客户端
  config.js                 工具配置
  safety/                   路径检查与通用等待超时
  tools/                    注册表、命令及三个文件工具
test/
  agent.test.js             假模型多轮任务、错误和停止条件
  cli.test.js               本地 HTTP 兼容接口的端到端测试
  eval.test.js              测评隔离、文件检查和失败判定
  其余测试                   工具、路径与超时
```

## 2. 调用链

```text
CLI → runAgent(task, model, registry, budgets)
  → 将注册工具的 Zod schema 转为 JSON Schema
  → model.complete(messages, tools, AbortSignal)
  → 最终文本：返回 completed
  → 结构化工具调用：验证 call ID/参数 → registry.invoke(name, args)
  → 以相同 call ID 追加 tool 消息 → 下一轮模型请求
```

模型层使用 `openai` SDK 的 `chat.completions.create`。配置项为 `MODEL_NAME`、`MODEL_API_KEY`、可选 `MODEL_BASE_URL`；CLI 也接受 `OPENAI_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`。未设置 URL 时使用 SDK 默认的 OpenAI 服务。当前没有流式输出、Responses API 或厂商专属协议。兼容服务仍需实测工具调用、参数格式和工具结果回传；仅能聊天不等于能运行本 Agent。

`runAgent()` 每次模型请求算一轮，默认最多 12 轮、总耗时 120 秒，按消息和工具定义序列化后的字符数检查 120000 字符预算。这是粗略上限，**不是 token 计数**。总耗时到达时中止模型网络请求，并将取消信号传给工具注册表；命令工具尝试终止其进程。文件工具的底层 I/O 尚未实现中途取消。模型错误、协议错误、上下文上限、轮数上限、取消和超时分别有终止状态。

运行事件记录模型轮次、耗时、工具调用数量、用量以及工具名、调用 ID、耗时与部分错误类别；不复制完整参数和文件内容到事件中。CLI 输出进度摘要，`runAgent()` 返回事件数组。**工具返回的字符串并无统一的成功标志**：运行事件中的 `returned` 只表示工具返回了内容，不表示副作用成功。未知工具与参数错误可单独标记；工具内部捕获的 I/O 错误目前仍需阅读文本。

## 3. 工具与权限

`createToolRegistry(overrides, { includeExecCommand })` 组装内置工具。CLI 默认 `includeExecCommand: false`，只有传 `--allow-shell` 才提供 `exec_command`。直接调用注册表的代码可以自行选择是否包含命令工具。`registry.invoke()` 继续返回模型可读字符串；可选的第三个参数把 `AbortSignal` 传给工具。`getProcessor()` 仍提供 `compact` / `summarize`，目前 Agent 没有消费它们。

| 工具 | 当前行为 | 关键边界 |
|---|---|---|
| `exec_command` | 捕获 stdout、stderr、退出码；超时或取消时尝试终止进程 | `cwd` 检查不限制命令本身；Windows 依赖 `taskkill /t /f`，POSIX 只杀直接子进程 |
| `read_file` | 读取 UTF-8 文本，拒绝无效编码及 NUL | 长内容截断，不适于解析完整大文件 |
| `list_directory` | 列出直接子项 | 不递归，列表长度有限 |
| `write_file` | 默认只新建；覆盖时先写同目录临时文件再替换 | 不建父目录，不提供并发冲突检测 |

命令子进程会过滤名称符合常见 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL` 模式的环境变量。这**不是凭据隔离**：命令仍能读工作区外文件，也可能读 `.env` 等磁盘凭据。CLI 要求显式指定任务目录并拒绝其根目录中的 `.env`，但不能证明整个目录树没有秘密文件；只在可信的一次性目录开启 shell。文件工具的真实路径检查也存在检查与使用之间的竞态。详见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

## 4. 配置与运行

需要 Node.js 22+、pnpm 11.10+。CLI 从当前目录加载 `.env`，也可直接使用进程环境变量。

```bash
pnpm install
node src/index.js --workspace ./scratch "在 result.txt 写入 hello"
node src/index.js --workspace ./scratch --allow-shell "运行该目录里的测试"
pnpm test
pnpm run eval
```

`AGENT_MAX_TURNS`、`AGENT_MAX_DURATION_MS`、`AGENT_MAX_CONTEXT_CHARS` 为 CLI 的严格正整数配置。工具层仍使用 `WORKSPACE_ROOT`、`SHELL_PATH`、`COMMAND_TIMEOUT`、`MAX_COMMAND_TIMEOUT`、`MAX_OUTPUT_CHARS`、`MAX_WRITE_CHARS`；其中工具配置的环境变量解析仍采用 `parseInt(value) || default`，尚未统一验证。命令输出上限分别作用于 stdout 和 stderr，不是完整工具结果的硬上限。

离线测试包含假模型任务与本地 HTTP 服务端到端流程，不需外网和真实密钥。Windows 真正的进程终止测试依赖系统允许 `taskkill`；拒绝时会报告终止失败。`withTimeout()` 仍只停止等待 Promise，不会取消底层操作；模型请求采用 SDK 的 `AbortSignal`。

`pnpm run eval` 使用真实模型，当前顺序运行两个文件任务和一个代码修复任务。每项测评用 `mkdtemp` 创建独立工作区；文件任务只注册文件工具，代码任务显式注册 `exec_command`。检查器验证精确文件内容、根目录集合、受保护夹具未修改、Agent 实际调用过命令，并独立执行 `node --test`。模型返回 `completed` 只是必要条件，检查失败仍判为失败。

`--repeat` 最多允许 20 轮。每次命令把汇总、逐项检查和不含工具参数的事件写入 `eval-results/<timestamp>.json`；该目录不入库。默认清理工作区，`--keep-workspaces` 会保留并打印路径。首个真实基线和异常记录见 [EVALUATION.md](./EVALUATION.md)。

## 5. 尚未完成的 M1 验收

- 扩充不同难度的代码夹具，并通过重复运行判断当前 3/3 小样本是否能在更长时间窗口保持稳定。
- 为工具 I/O 结果增加机器可读状态，区分成功、拒绝、错误和截断；避免从中文结果文本推断。
- 根据真实任务的轨迹决定是否需要更精确的 token 预算、压缩、流式进度及厂商差异处理。
