# 架构与运行

> 本文记录**仓库已经实现的行为**，并单独标注 M1 设计草案。目标和验收见 [GOALS.md](./GOALS.md)，取舍见 [DESIGN.md](./DESIGN.md)，不可忽略的边界见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

## 1. 当前状态

运行时为 Node.js ESM；参数校验依赖 Zod，测试使用 `node:test`。`src/` 目前只有配置、安全辅助函数和四个工具，**没有模型客户端、Agent 循环、CLI 或可运行的 `src/index.js`**。`package.json` 的 `main` 指向该不存在的文件；在入口实现前，不应把本仓库当作可执行 Agent 或可导入包。

```text
src/
  config.js
  safety/
    sandbox.js          词法路径边界
    timeout.js          Promise 等待超时，不取消底层操作
  tools/
    registry.js         注册、Zod 校验、调用和错误文本化
    index.js            内置工具组装
    execCommand.js      shell 命令执行
    filePaths.js        文件工具的真实路径检查
    readFile.js
    listDirectory.js
    writeFile.js
test/
  sandbox.test.js
  timeout.test.js
  execCommand.test.js
  fileTools.test.js
```

## 2. 当前调用链

```text
测试或未来的运行时
  → createToolRegistry(config 覆盖项)
  → registry.invoke(name, rawArgs)
      → 查找工具 → Zod safeParse → tool.invoke(parsedArgs)
      → 返回可读字符串；未知工具、参数错误和异常也返回字符串
```

`registry.list()` 返回工具定义。`registry.getProcessor(name)` 提供 `compact` / `summarize`，**当前没有 Agent 或终端层调用它们**；注册处理器不等于已实现终端呈现。`registry.invoke()` 只返回字符串，没有结构化成功标志、错误类别或调用轨迹。M1 需要在不丢失模型可读内容的前提下，建立运行时可判断的状态。

| 工具 | 当前行为 | 需要知道的边界 |
|---|---|---|
| `exec_command` | shell 执行；捕获 stdout、stderr、退出码；超时尝试终止进程 | `cwd` 检查不约束命令本身；Windows 用 `taskkill /t /f`，POSIX 只向直接子进程发 `SIGKILL`；终止失败会返回错误 |
| `read_file` | 读取 UTF-8 文本前缀，拒绝无效编码与 NUL | 内容过长截断，不能用于完整解析大文件或二进制文件 |
| `list_directory` | 列出一个目录的直接子项 | 不递归；达到长度上限后停止 |
| `write_file` | 默认仅新建，`overwrite: true` 时在同目录写临时文件再替换 | 不自动建父目录；文本长度有上限；不提供并发冲突检测 |

文件工具先用 `resolveInWorkspace` 检查词法路径，再用 `realpath` 检查已有目标或待写入文件的父目录。它们拒绝经目录链接访问工作区外，但检查与操作之间仍可能发生并发路径替换。`exec_command` 不经过文件工具的真实路径检查。完整说明见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

`MAX_OUTPUT_CHARS` 目前限制 `exec_command` 的 **stdout 与 stderr 各自**的累计内容，并限制读文件或列目录的主体内容；状态行、路径和截断提示会使最终字符串更长。它不是整个工具结果的统一硬上限。

## 3. 配置与依赖

| 环境变量 | 当前默认值 | 用途 |
|---|---:|---|
| `WORKSPACE_ROOT` | 仓库根目录 | 文件路径检查的根；命令的默认工作目录 |
| `SHELL_PATH` | 自动探测；否则系统默认 shell | Windows 优先常见 Git Bash 路径，找不到时回退；不能保证一定使用 Bash |
| `COMMAND_TIMEOUT` | 30000 ms | 单条命令默认超时 |
| `MAX_COMMAND_TIMEOUT` | 600000 ms | 工具参数 `timeoutMs` 的上限 |
| `MAX_OUTPUT_CHARS` | 8000 | 命令每个输出流、读文件或列目录的主体长度 |
| `MAX_WRITE_CHARS` | 100000 | 单次写入的文本长度 |

配置当前使用 `parseInt(value) || default`，尚未统一验证正整数及配置项之间的关系。`package.json` 同时写有 pnpm `devEngines: ^11.10.0` 和 `engines: >=8.0.0`，支持范围互相矛盾；统一版本要求属于后续代码修复，不应只改文档数字。

## 4. 测试与运行

```bash
pnpm install
pnpm test                 # node --test
node --test test/fileTools.test.js
```

目前有 35 个离线测试：路径检查 10、通用超时 5、命令工具 13、文件工具 7。Windows 的真实进程终止测试依赖系统允许 `taskkill`；在限制进程终止的沙箱中会失败。这类失败应看作环境边界的信号，不应把测试改成“只要返回超时文本就通过”。

`withTimeout()` 通过 `Promise.race` 限制等待时间，**不会取消底层 Promise**。未来的模型网络请求需要由适配层使用可取消的请求机制。

## 5. M1 设计草案：有界工具调用循环

M1 从单 Agent 开始。模型接口先适配一个 provider，向运行时返回统一形状的“最终答复或结构化工具调用”。工具仍经注册表校验和调用；运行时保留工具调用 ID，并把对应结果反馈给模型。不要用自由文本 `Thought:` / `Action:` 作为机器协议。

```text
messages = [system, user(task)]
在轮数、总耗时和上下文预算内循环：
  model.generate(messages, toolSchemas, abortSignal)
  若模型给出最终答复 → 结束
  若模型给出工具调用 → 对每个 call 记录 ID、名称和参数
    → 校验与执行 → 记录结果、耗时和错误类别
    → 以相同 call ID 回传工具结果，进入下一轮
  若模型或工具协议无效 → 返回明确的失败状态
到达上限 → 停止并报告未完成原因
```

首批测试用假模型验证多步工具调用、参数错误后的恢复、停止条件和取消；再在一次性测试工作区用真实模型跑一个小任务。评测与轨迹记录从 M1 开始，后续是否加入规划、记忆或子 Agent 由失败样本决定。

## 6. 已知设计债与决定时机

| 问题 | 当前影响 | 建议时机 |
|---|---|---|
| shell 不受工作区路径检查约束，没有工具权限策略或进程隔离 | 不宜对不可信任务无人值守运行 | M1 自主执行前明确运行环境和权限边界 |
| 工具结果只有字符串；处理器尚无消费者 | 运行时难以区分失败、截断和正常结果 | M1 设计内部结果结构与轨迹 |
| 没有真实入口；`package.json.main` 指向不存在的文件 | 无法作为 CLI 或包启动 | M1 增加入口时一起修正 |
| POSIX 超时只杀直接子进程；Windows `taskkill` 可能被拒绝 | 后代进程可能残留 | 需要跨平台长跑前做进程树验证与修复 |
| 输出上限按流而非整体；配置值未严格校验 | 上下文和资源预算不精确 | M1 上下文预算接线前修复 |
| pnpm 版本声明冲突 | 安装要求不清晰 | 下一次维护 `package.json` 时统一 |
| 无终端实时输出或运行轨迹 | 人无法观察长命令进度 | M1 加入呈现与追踪时实现 |

模型 SDK、网络请求协议、记忆存储和多 Agent 结构均未选定。先做一个可替换的模型适配边界，再依据真实调用和评测选具体依赖；不要为尚未出现的多 provider 需求写通用框架。
