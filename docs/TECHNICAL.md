# 架构与运行

> 本文记录仓库**已经实现的行为**。项目目标和未完成的 M1 验收见 [GOALS.md](./GOALS.md)，取舍见 [DESIGN.md](./DESIGN.md)，安全边界见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

## 1. 当前结构

运行时为 Node.js ESM。`openai` SDK 只承担 Chat Completions 网络请求，`dotenv` 为 CLI 加载本地配置，Zod 校验工具参数并转换 JSON Schema；Agent 循环由本仓库实现，测试使用 `node:test`。

```text
src/
  index.js                  CLI：配置、权限选择、进度与最终状态
  eval.js                   真实模型固定测评入口
  agent/runAgent.js         单 Agent 工具调用循环及运行事件
  agent/toolBatch.js        同一轮多个工具调用的并发执行与路径冲突保护
  agent/context.js          上下文估算、分级压缩与保护窗口
  agent/checkpointStore.js  SQLite 会话与 checkpoint 存储
  agent/episodicMemory.js   情景记录生成、文字相关性排序与上下文限长
  evals/                    固定任务、工作区准备、检查器与测评运行器
  model/openaiCompatible.js OpenAI 兼容 Chat Completions 客户端
  config.js                 工具配置
  safety/                   路径检查与通用等待超时
  tools/                    注册表、两个命令后端及五个文件工具
test/
  agent.test.js             假模型多轮任务、错误和停止条件
  context.test.js           上下文估算、四级压缩、保护窗口与降级路径
  toolBatch.test.js         同轮并发、同路径串行、取消与结果顺序
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
  → 结构化工具调用：验证 call ID/参数 → runToolBatch 并发执行
  → 以相同 call ID 按模型给出的顺序追加 tool 消息 → 下一轮模型请求
```

模型层使用 `openai` SDK 的 `chat.completions.create`。配置项为 `MODEL_NAME`、`MODEL_API_KEY`、可选 `MODEL_BASE_URL`；CLI 也接受 `OPENAI_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`。未设置 URL 时使用 SDK 默认的 OpenAI 服务。当前没有流式输出、Responses API 或厂商专属协议。兼容服务仍需实测工具调用、参数格式和工具结果回传；仅能聊天不等于能运行本 Agent。

## 3. 一轮里的多个工具调用（`src/agent/toolBatch.js`）

模型经常在一轮里同时发 2–3 个调用（真实轨迹里 10 轮有 7 轮如此）。原先逐条 await，等于把「各读一个文件」这类本来就独立的等待叠起来。现在同轮并发，但保留三条确定性保证：

| 保证 | 做法 | 为什么必须有 |
|---|---|---|
| 消息与事件顺序不变 | 并发只负责执行；追加 tool 消息、写 checkpoint、发事件统一按模型给出的顺序做 | 协议要求 tool 消息与 `tool_calls` 对应；乱序会让轨迹无法对照 |
| 同一路径的调用串行 | 按路径维护一条串行链：后一条先 await 前一条完成 | 两个 `apply_patch` 改同一文件时，若都读旧内容再各自原子替换，后写的会静默覆盖前一次 |
| checkpoint 粒度不变 | 每条调用各自写 `tool_running` 与 `tool_batch` | 崩溃恢复时只有正在飞的那一条会被标为「结果未知」，其余不重放 |

路径取自工具参数里的 `filePath`、`cwd` 或 `path`；取不到路径的调用（例如 `exec_command`）不参与串行，直接并发。

`planPhases()` 用「阶段划分」表达了同一套规则，并作为测试基准；实际执行用按路径的串行链 —— 阶段划分会让后建立的阶段整体等待前一个阶段结束，从而顺带卡住无关的调用。

运行事件里每轮新增一条 `batch` 事件，仅在真的并发时发出，记录该轮的调用数。CLI 会打印「N 个工具调用并发执行」。

## 4. 预算、压缩与重试

`runAgent()` 每次模型请求算一轮，默认最多 12 轮、总耗时 120 秒，按消息和工具定义序列化后的字符数检查 120000 字符预算。这是粗略上限，**不是 token 计数**。总耗时到达时中止模型网络请求，并将取消信号传给工具注册表；命令工具尝试终止其进程。文件工具的底层 I/O 尚未实现中途取消。模型错误、协议错误、上下文上限、轮数上限、取消和超时分别有终止状态。

模型请求按 `AGENT_MODEL_MAX_RETRIES`（默认 2）重试，交给 `openai` SDK 做指数退避，并尊重服务端的 `Retry-After`。重试只放在模型层：模型请求幂等，而工具可能有副作用，自动重试等于重复执行。重试会消耗总耗时预算，所以两者要一起看。重试耗尽后的错误会带上状态码与重试次数，例如 `模型请求失败 HTTP 503 （已重试 2 次）: ...`。


上下文预算分两级（见 `src/agent/context.js`）：达到硬预算的比例 `AGENT_CONTEXT_SOFT_RATIO`（默认 0.7）时先压缩历史，压缩后仍超过硬预算才以 `context_limit` 终止。压缩分四级、逐级加严，省够即停；前四级用尽仍超硬预算时再加两级应急截断：

| 级别 | 动作 | 说明 |
|---|---|---|
| L1 | 用工具自己声明的 `compact` 处理器截断长工具结果 | 默认上限 1200 字符；处理器结果仍超上限时按上限硬截并留下标记；保护窗口内的结果跳过 |
| L2 | 把上限收严到 L1 的 1/6 | 只有第一级不够时才加严；同样跳过保护窗口 |
| L3 | 保护窗口之前的工具结果整体换成引用 | 调用参数仍在 assistant 消息里，模型可据此重读 |
| L4 | 丢弃保护窗口之前的整段历史 | 在整块交换的边界下刀，并插入「已省略 N 轮」标记 |
| L5/L6 | 应急：连保护窗口内的结果也截断（1200，仍超硬预算再收到 200） | 只在窗口本身就让上下文超过硬预算时触发；不触发就只能以 `context_limit` 终止 |

保护窗口由 `AGENT_KEEP_RECENT_TURNS`（默认 2）控制，单位是「交换」：一组 assistant 工具调用加它的 tool 结果算一次。L1–L4 都不触碰保护窗口：工具结果产生后模型要到下一轮才看得到，这一轮就把它截掉等于没读到。L5/L6 是唯一例外 —— 如果窗口本身超过硬预算，前四级无能为力，此时宁可让模型看到截短的结果，也不要整趟任务被硬闸门终止。压缩不可拆散协议配对 —— system 消息、原始任务、以及每条带 `tool_calls` 的 assistant 消息与它的 tool 结果始终同进同出；`test/context.test.js` 对每个用例都验证这条不变式。压缩本身是幂等的，恢复会话时按消息里的省略标记续算已丢弃轮数；丢弃标记里的轮数是累计值，不随新的丢弃被覆盖。

每轮先压缩、后检查硬预算。顺序很关键：恢复一个已经超预算的 checkpoint 时，如果硬闸门排在压缩之前，这一轮会立刻终止，压缩永远没有机会救回它。压缩后仍超硬预算时，运行以 `context_limit` 终止，并先发一个 `action: 'insufficient'` 的 `context` 事件说明压缩已经用尽。

模型事件里的 `usage` 是服务端口径；`context` 事件另给 `estimatedTokens`，用字符规则粗略估算（中日韩字符约一字一 token，ASCII 约四字符一 token），**只用于观察量级，不参与预算判定**。

运行事件记录模型轮次、耗时、工具调用数量、用量以及工具名、调用 ID、耗时与结果状态；上下文压缩另有 `context` 事件，`action` 为 `compacted`（记录生效级别、省下的字符、当前长度、软/硬阈值、累计压缩轮数与估算 token）或 `insufficient`（压缩已用尽、仍超硬预算，随后终止）。事件不复制完整参数和文件内容。CLI 输出进度摘要，`runAgent()` 返回事件数组。工具事件的 `status` 为 `success`、`rejected`、`error` 或 `truncated`，另有 `truncated` 布尔值。`outcome` 保留更具体的 `unknown_tool`、`invalid_arguments`、`tool_exception`，其余情况与 `status` 相同。状态由工具产生，不解析返回文案。

## 5. 工具与权限

`createToolRegistry(overrides, { includeExecCommand, sandbox })` 组装内置工具。命令工具有两个互斥后端，二者都叫 `exec_command`：默认不注册；`--allow-shell` 注册进程内后端；`--docker` 注册容器后端。两个都传时注册表直接抛错，不做隐式降级。`registry.invoke()` 继续返回模型可读字符串；`registry.invokeResult()` 返回 `{ status, content, truncated }`，可选 `code` 表示注册表层的具体错误。两者的可选第三个参数都可把 `AbortSignal` 传给工具。内置工具在输入不合要求或触及工作区边界时返回 `rejected`，I/O 与命令执行失败返回 `error`，结果不完整时返回 `truncated`；若命令同时失败和截断，`status` 为 `error`、`truncated` 为 `true`。自定义的纯文本工具仍受支持，但无法提供准确的失败状态，注册表将其视为 `success`。`getProcessor()` 提供 `compact` / `summarize`：`compact` 已用于上下文压缩的 L1/L2（见上），`summarize` 仍没有消费者。

| 工具 | 当前行为 | 关键边界 |
|---|---|---|
| `exec_command`（`--allow-shell`） | 捕获 stdout、stderr、退出码；超时或取消时尝试终止进程 | `cwd` 检查不限制命令本身；Windows 依赖 `taskkill /t /f`，POSIX 只杀直接子进程 |
| `exec_command`（`--docker`） | 在一次性容器内执行；只挂载工作区、根只读、无网络、结束即删容器 | 需要本机 Docker 与已拉取镜像；容器内的 root 与外层用户不同，文件属主可能变化 |
| `read_file` | 读取 UTF-8 文本，拒绝无效编码及 NUL | 长内容截断，不适于解析完整大文件 |
| `list_directory` | 列出直接子项 | 不递归，列表长度有限 |
| `search_files` | 递归进行单行字面量搜索，返回文件与行列位置 | 跳过链接、二进制、大文件、`.git` 和 `node_modules`；限制扫描文件数、匹配数和输出长度 |
| `apply_patch` | 按顺序执行一个或多个精确文本替换 | 默认要求唯一匹配，只修改已有 UTF-8 文件；全部校验完成后原子替换 |
| `write_file` | 默认只新建；覆盖时先写同目录临时文件再替换 | 不建父目录，不提供并发冲突检测 |

命令子进程会过滤名称符合常见 `API_KEY`、`TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL` 模式的环境变量。这**不是凭据隔离**：命令仍能读工作区外文件，也可能读 `.env` 等磁盘凭据。CLI 要求显式指定任务目录并拒绝其根目录中的 `.env`，但不能证明整个目录树没有秘密文件；只在可信的一次性目录开启 shell。文件工具的真实路径检查也存在检查与使用之间的竞态。详见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

### 沙箱执行后端（`--docker`）

`src/tools/dockerCommand.js` 把命令放进一次性容器。每次调用做四件事：

1. **回收残留**：按标签 `agent-harness.sandbox=1` 列出并删除上次遗留的容器。进程被强杀时 `--rm` 可能来不及生效，残留容器会继续占资源，所以每次执行前先清一次。
2. **组装并运行**：`docker run --rm`。命令作为最后一个参数交给 `sh -c`，不参与参数拼接；`cwd` 先用 `resolveInWorkspace` 校验，再换算成容器内路径（工作区固定挂到 `/workspace`）。
3. **删除容器**：无论成功、失败、超时还是取消，都执行 `docker rm -f`；按名字删除失败时再按标签兜底。兜底必须真的删掉了东西才算成功，否则会把失败说成成功。
4. **回传结果**：复用 `exec_command` 的 `formatResult`，并注明镜像、网络状态与容器名。模型看到的「成功 / 超时 / 无输出」措辞与进程内后端一致。

| 参数 | 作用 |
|---|---|
| `--network none` | 没有网卡：读不到内网服务，也无法外传数据 |
| `--cap-drop ALL` | 丢掉全部 Linux capability |
| `--security-opt no-new-privileges` | 禁止 setuid 提权 |
| `--read-only` | 根文件系统只读，只有工作区与 `/tmp` 可写 |
| `--tmpfs /tmp` | 给需要临时文件的工具留一块内存盘 |
| `--memory` / `--cpus` / `--pids-limit` | 限制资源，避免 fork 炸弹拖垮宿主 |
| `-v <工作区>:/workspace:rw` | 唯一的挂载点 |
| `--user`（默认 `0:0`） | 容器内运行身份；隔离由容器边界负责，不由容器内用户负责 |

`inspectDocker()` 在启动前检查 Docker 与镜像。CLI 与测评在这一步失败时直接退出或抛错，**不做静默降级**：宁可拒绝执行，也不让「以为有隔离」发生。真实隔离断言（工作区可写、根只读、无网络、超时后无残留容器）在 `test/dockerCommand.test.js` 中，只有本机 Docker 与镜像可用时才真实执行，否则跳过并打印原因。

## 6. 配置与运行

需要 Node.js 22.13+、pnpm 11.10+。CLI 从当前目录加载 `.env`，也可直接使用进程环境变量。

```bash
pnpm install
node src/index.js --workspace ./scratch "在 result.txt 写入 hello"
node src/index.js --workspace ./scratch --docker "运行该目录里的测试"
node src/index.js --workspace ./scratch --allow-shell "运行该目录里的测试"
pnpm test
pnpm run eval
pnpm run eval --docker
```

CLI 可通过 `--session <ID>` 开始持久化会话，以 `--resume <ID>` 从 SQLite 恢复。默认数据库为 `.agent-harness/checkpoints.sqlite`，也可用 `--checkpoint-db <路径>` 指定。`src/agent/checkpointStore.js` 使用 Node 自带的 `node:sqlite`，将会话元数据与 checkpoint 快照写入事务；每次工具调用前记录运行中状态，结果返回后再记录工具消息。恢复时补全尚未收到结果的工具消息：运行中的调用标为结果未知，后续未启动的调用标为未执行，不直接重放。完成状态、回答及累计轮数也入库。checkpoint 只存消息，不单独存压缩计数；恢复时按消息里已有的「已省略」标记续算，因此不会因为恢复而重复丢弃。数据库保存完整消息与工具输出，不应放在 Agent 工作区内。

指定 `--project <ID>` 时，CLI 自动建立会话（也可显式指定 `--session`），在完成时将截短的任务、最终答复及工具名称写入 `memory_episodes`。会话完成状态与记忆记录在同一 SQLite 事务中写入。新任务只从同项目最近 200 条记录中做文字相关性排序，选最多三条，并限制注入长度；记录作为当前任务之前的用户参考消息提供给模型。历史答复未经过独立验收，提示中明确要求先核实；当前没有长期知识提炼、向量索引或中文分词服务。

`AGENT_MAX_TURNS`、`AGENT_MAX_DURATION_MS`、`AGENT_MAX_CONTEXT_CHARS`、`AGENT_KEEP_RECENT_TURNS`、`AGENT_DOCKER_PIDS` 为 CLI 的严格正整数配置，`AGENT_CONTEXT_SOFT_RATIO` 必须是 (0, 1] 之间的数值，`AGENT_MODEL_MAX_RETRIES` 必须是 0 到 5 之间的整数；沙箱另有 `AGENT_DOCKER_IMAGE`、`AGENT_DOCKER_MEMORY`、`AGENT_DOCKER_CPUS`、`AGENT_DOCKER_USER`、`AGENT_DOCKER_BINARY`。工具层仍使用 `WORKSPACE_ROOT`、`SHELL_PATH`、`COMMAND_TIMEOUT`、`MAX_COMMAND_TIMEOUT`、`MAX_OUTPUT_CHARS`、`MAX_WRITE_CHARS`、`MAX_SEARCH_FILES`、`MAX_SEARCH_FILE_BYTES`；其中工具配置的环境变量解析仍采用 `parseInt(value) || default`，尚未统一验证。命令输出上限分别作用于 stdout 和 stderr，不是完整工具结果的硬上限。

离线测试包含假模型任务与本地 HTTP 服务端到端流程，不需外网和真实密钥。Windows 真正的进程终止测试依赖系统允许 `taskkill`；拒绝时会报告终止失败。`withTimeout()` 仍只停止等待 Promise，不会取消底层操作；模型请求采用 SDK 的 `AbortSignal`。

`pnpm run eval` 使用真实模型，当前顺序运行七个文件任务、一个代码修复任务和一个需要 `--docker` 的沙箱任务（共九项）。每项测评用 `mkdtemp` 创建独立工作区；文件任务只注册文件工具，代码任务在进程内后端下显式注册 `exec_command`，加 `--docker` 后所有命令一律进容器。检查器验证精确文件内容、目录集合、受保护夹具未修改、搜索和补丁工具调用、命令调用，并独立执行 `node --test`。模型返回 `completed` 只是必要条件，检查失败仍判为失败。声明 `requiresSandbox` 的任务在没有沙箱时直接判失败，不会静默跳过。用例可以声明 `maxTurns` 与 `maxDurationMs` 覆盖默认预算，实际生效值记录在每条结果（JSON 报告的 `budget` 字段）里。预算从参考解法成本推导，而不是调到通过为止：`sweep-audit-weights` 的参考解法是逐个读取 24 个文件（本机 50–95 秒、8–12 轮），所以轮数放到 16、耗时安全网放到 240 秒（约 ×3），只用来兜慢请求，不用来判效率 —— 效率仍看轮数、工具调用和耗时本身。

`--repeat` 最多允许 20 轮。每次命令把汇总、逐项检查和不含工具参数的事件写入 `eval-results/<timestamp>.json`；该目录不入库。默认清理工作区，`--keep-workspaces` 会保留并打印路径。首个真实基线和异常记录见 [EVALUATION.md](./EVALUATION.md)。

## 7. 尚未完成的 M1 验收

- 扩充不同难度的代码夹具，让上下文压力在真实任务里出现，再通过重复运行判断当前小样本是否能在更长时间窗口保持稳定。
- 根据真实任务的轨迹判断压缩策略是否伤害结果：需要记录「压缩后模型是否重读了被省略的文件」这类轨迹，目前只有合成夹具与 25 次探索样本。
- 根据真实任务的轨迹决定是否需要更精确的 token 预算、流式进度及厂商差异处理。
- 运行 `explore-large-repo` 与 `sweep-audit-weights` 的分布：前者修复后 5/5 通过（3 轮、约 3 秒），说明点名常量的检索路径不构成上下文压力；后者 25 次运行答对 15 次，10 次失败全部来自耗时或轮数预算，没有上下文超限。用例现在各自声明轮数与耗时安全网（sweep 为 16 轮 / 240 秒），实际值记入报告；接下来要评估是否调整夹具让「逐位试探」不再比读取划算，再判断是否需要子 Agent（见 [DESIGN.md](./DESIGN.md) D14）。
