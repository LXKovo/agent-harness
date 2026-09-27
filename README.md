# agent-harness

一个用于学习和验证 coding agent 基础结构的 Node.js 项目。现在可以通过 OpenAI 兼容的 Chat Completions 接口运行**有轮数和耗时上限的单 Agent**：模型选择工具，程序校验并执行工具，再把结果按调用 ID 回传。运行仍限于可信、受控的任务目录。

## 运行一个任务

需要 Node.js 22+ 和 pnpm 11.10+。安装依赖后，将 `.env.example` 复制为 `.env`，填写 `MODEL_NAME`、`MODEL_API_KEY`；连接其他兼容服务时填写 `MODEL_BASE_URL`（通常以 `/v1` 结尾）。也接受对应的 `OPENAI_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`。CLI 从当前目录加载 `.env`。

```bash
pnpm install
node src/index.js --workspace ./scratch "在 result.txt 中写入 hello"
```

先自行创建 `scratch`，并把任务文件放进去。CLI 要求显式指定工作区，且拒绝工作区根目录中的 `.env`。默认只提供 `read_file`、`list_directory`、`write_file`；确需运行测试或其他命令时，在**可信的一次性目录**中加 `--allow-shell`。命令工具不是进程沙箱，能访问工作区外的资源，也可能读取磁盘上的凭据文件。详细边界见 [约束文档](docs/CONSTRAINTS.md)。

模型服务必须支持 Chat Completions 的结构化工具调用；只支持纯文本聊天的兼容接口无法完成文件任务。当前实现不使用 Responses API，也不提供流式输出。

## 配置与测试

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `AGENT_MAX_TURNS` | 12 | 最多模型请求轮数 |
| `AGENT_MAX_DURATION_MS` | 120000 | 整次任务的耗时上限 |
| `AGENT_MAX_CONTEXT_CHARS` | 120000 | 消息和工具定义的字符预算；不是精确 token 预算 |

```bash
pnpm test
```

Windows PowerShell 若阻止 `pnpm.ps1`，可使用 `pnpm.cmd`。测试不使用真实 API Key：假模型验证多轮工具调用，本地 HTTP 服务验证 CLI 和兼容接口。Windows 上的真实进程终止用例需要 `taskkill` 权限；若系统拒绝，工具会报告终止失败。

## 运行固定测评

固定测评会调用 `.env` 中配置的真实模型，因此会产生对应服务的请求和费用。每个任务使用独立的系统临时目录，只开放三个文件工具；程序根据最终文件判定结果，不采信模型的“已完成”声明。

```bash
pnpm run eval                              # 运行全部测评并保存 JSON 报告
pnpm run eval --repeat 3                   # 连续运行三轮
pnpm run eval --list                       # 查看测评名称
pnpm run eval --case create-exact-file
pnpm run eval --keep-workspaces            # 保留临时目录供人工检查
```

当前有三个基线：精确创建文件、读取并转换已有文件，以及修复代码并运行测试。前两个只开放文件工具；代码任务在一次性夹具中开放 shell，并由测评程序独立复跑测试。输出会显示每项检查、模型轮数、耗时和总通过率，JSON 报告写入被 Git 忽略的 `eval-results/`。默认在测评结束后清理临时目录。首轮真实基线见 [固定测评文档](docs/EVALUATION.md)。

## 当前工具与限制

| 工具 | 能力 | 主要边界 |
|---|---|---|
| `exec_command` | 执行 shell 命令，返回 stdout、stderr 和退出状态 | CLI 默认关闭；限制工作目录和时间，但不限制命令可访问的文件 |
| `read_file` | 读取 UTF-8 文本 | 检查真实路径，拒绝无效 UTF-8 和二进制内容，截断长内容 |
| `list_directory` | 列出目录的直接子项 | 检查真实路径，限制列表长度 |
| `write_file` | 写入 UTF-8 文本 | 默认拒绝覆盖，覆盖须显式指定；限制写入大小 |

M1 首版已经跑通：真实模型可完成文件任务和小型代码修复，3 个固定任务连续 3 轮取得 9/9 通过。后续改动应重复运行相同测评，观察成功率、轮数和失败模式是否退化。目标见 [GOALS.md](docs/GOALS.md)，代码流程见 [TECHNICAL.md](docs/TECHNICAL.md)，设计取舍见 [DESIGN.md](docs/DESIGN.md)。
