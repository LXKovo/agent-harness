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
  tools/                    注册表、两个命令后端、五个文件工具与两个网络工具
  tools/web/                网络工具的 URL 校验、内容提取与 HTTP 读取
test/
  agent.test.js             假模型多轮任务、错误和停止条件
  context.test.js           上下文估算、四级压缩、保护窗口与降级路径
  toolBatch.test.js         同轮并发、同路径串行、取消与结果顺序
  cli.test.js               本地 HTTP 兼容接口的端到端测试
  eval.test.js              测评隔离、文件检查和失败判定
  webTools.test.js          网络 URL 安全、抓取、搜索解析与注册边界
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

运行事件记录模型轮次、耗时、工具调用数量、用量以及工具名、调用 ID、耗时与结果状态；上下文压缩另有 `context` 事件，`action` 为 `compacted`（记录生效级别、省下的字符、当前长度、软/硬阈值、累计压缩轮数与估算 token，以及这次新整条省略的 `omittedCallIds` / `omittedFiles` 和累计 `omittedFileCount` / `rereadFileCount`）或 `insufficient`（压缩已用尽、仍超硬预算，随后终止）。事件不复制完整参数和文件内容。CLI 输出进度摘要，`runAgent()` 返回事件数组。工具事件的 `status` 为 `success`、`rejected`、`error` 或 `truncated`，另有 `truncated` 布尔值。`outcome` 保留更具体的 `unknown_tool`、`invalid_arguments`、`tool_exception`，其余情况与 `status` 相同。状态由工具产生，不解析返回文案。

压缩轨迹从 2026-10-23 起可观测：`compactMessages()` 返回的 `omittedCallIds` 只包含这次新被「整条省略」的工具结果（L3 换引用、L4 丢弃），不含 L1/L2 截断；`runAgent()` 把被省略的 `read_file` 调用映射回文件路径，累计到 `state.compression.omittedPaths`，并把该 Map 写入 checkpoint。模型下一次读取同一路径时，运行层先记录 `readPaths`，再判断它是否在被省略集合里；是则增加 `rereadCalls`、把路径加入 `rereadPaths`，并发一条 `reread` 事件（字段为 `turn`、`callId`、`path`、`first`）。停止事件与 `runAgent()` 结果都带压缩快照，CLI 摘要显示省略结果数、被省略文件数、重读次数与重读比例。该比例只回答「模型有没有重新取回被省略的来源」，不判断重读是否必要，也不把「没有重读」当成错误。

## 5. 工具与权限

`createToolRegistry(overrides, { includeExecCommand, includeWeb, sandbox })` 组装内置工具。`includeWeb` 默认 `false`；只有 CLI 显式 `--web` 才注册 `web_fetch` / `web_search`。命令工具有两个互斥后端，二者都叫 `exec_command`：默认不注册；`--allow-shell` 注册进程内后端；`--docker` 注册容器后端。两个都传时注册表直接抛错，不做隐式降级。`registry.invoke()` 继续返回模型可读字符串；`registry.invokeResult()` 返回 `{ status, content, truncated }`，可选 `code` 表示注册表层的具体错误。两者的可选第三个参数都可把 `AbortSignal` 传给工具。内置工具在输入不合要求或触及工作区边界时返回 `rejected`，I/O 与命令执行失败返回 `error`，结果不完整时返回 `truncated`；若命令同时失败和截断，`status` 为 `error`、`truncated` 为 `true`。自定义的纯文本工具仍受支持，但无法提供准确的失败状态，注册表将其视为 `success`。`getProcessor()` 提供 `compact` / `summarize`：`compact` 已用于上下文压缩的 L1/L2（见上），`summarize` 仍没有消费者。

| 工具 | 当前行为 | 关键边界 |
|---|---|---|
| `exec_command`（`--allow-shell`） | 捕获 stdout、stderr、退出码；超时或取消时尝试终止进程 | `cwd` 检查不限制命令本身；Windows 依赖 `taskkill /t /f`，POSIX 只杀直接子进程 |
| `exec_command`（`--docker`） | 在一次性容器内执行；只挂载工作区、根只读、无网络、结束即删容器 | 需要本机 Docker 与已拉取镜像；容器内的 root 与外层用户不同，文件属主可能变化 |
| `read_file` | 读取 UTF-8 文本，拒绝无效编码及 NUL | 长内容截断，不适于解析完整大文件 |
| `list_directory` | 列出直接子项 | 不递归，列表长度有限 |
| `search_files` | 递归进行单行字面量搜索，返回文件与行列位置 | 跳过链接、二进制、大文件、`.git` 和 `node_modules`；限制扫描文件数、匹配数和输出长度 |
| `apply_patch` | 按顺序执行一个或多个精确文本替换 | 默认要求唯一匹配，只修改已有 UTF-8 文件；全部校验完成后原子替换 |
| `write_file` | 默认只新建；覆盖时先写同目录临时文件再替换 | 不建父目录，不提供并发冲突检测 |
| `web_fetch` | GET 一个公网 URL；HTML 转文本，JSON 保留原文；跟随有限重定向 | 仅 http/https 的 80/443；拒绝 localhost/内网/保留地址；默认不注册，需 `--web`；不执行 JS、不带 Cookie/登录态 |
| `web_search` | 查询搜索服务，返回标题、URL、摘要；去重并限制条数 | 默认 Bing HTML，可选 Tavily/DuckDuckGo；依赖第三方页面结构；结果不可信；默认不注册，需 `--web` |

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

### 只读网络工具（`--web`）

CLI 默认不注册网络工具；`--web` 才把 `web_fetch` / `web_search` 加入注册表，并把 `allow_web` 记入会话。恢复会话沿用该权限，不能在恢复时新增 `--web`。网络请求发生在宿主机进程内，**不经过 Docker**：`--docker` 的「无网络」只约束容器里的命令，不约束这两个工具。

`web_fetch` 只接受 `http`/`https`、80/443 端口、不带 userinfo 的 URL。`src/tools/web/urlSafety.js` 除检查主机名黑名单外，还会解析域名的全部地址，拒绝 loopback、链路本地、私网、ULA 等保留地址；手动跟随重定向（默认最多 5 次），每一跳都重新做同样检查。请求默认 15 秒超时；响应最多读取 2MB；只接受 `text/*`、JSON、XML 等文本类型，二进制直接拒绝。HTML 会被压成可读文本并保留绝对链接目标，JSON 保留原文；最终正文默认最多 8000 字符，超出标为 `truncated`。长页面可用 `offset` / `maxChars` 分段读取：偏移按 0 开始，结果会给出下一段的 `offset`；偏移落在代理对中间时回退到该字符起点；`offset` 超出已读取正文长度时明确拒绝。调用方的 `AbortSignal` 会取消请求。

`web_search` 默认 `WEB_SEARCH_PROVIDER=auto`：有 `TAVILY_API_KEY` 时用 Tavily JSON API，否则用 Bing 的 HTML 结果页；也可显式选 `bing`、`duckduckgo` 或 `tavily`。Bing 结果会解码 `bing.com/ck/a` 跳转，DuckDuckGo 会解码 `uddg` 跳转；两者都跳过广告项、按 URL 去重、标题截到 300 字符、摘要截到 500 字符。默认最多 8 条（工具参数可到 10），默认 15 秒超时，最终输出受 8000 字符上限约束。搜索没有稳定 API，选择器失效时返回「没有结果」而不是整页 HTML；第三方页面限流、验证码或改版都会让搜索失败，错误会作为工具结果回传，不抛出 Agent 循环。

两者都把网页或搜索摘要标为「外部内容，不可信」，但**标记不等于隔离**：网页文本仍可能包含针对模型的提示注入，模型仍可能把 URL 或查询词发到公网。URL 检查与实际连接之间还存在 DNS 重绑定的时间窗；不执行 JavaScript、不维持 Cookie/登录态，也不下载文件。详细边界见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

## 6. 配置与运行

需要 Node.js 22.13+、pnpm 11.10+。CLI 从当前目录加载 `.env`，也可直接使用进程环境变量。

```bash
pnpm install
node src/index.js --workspace ./scratch "在 result.txt 写入 hello"
node src/index.js --workspace ./scratch --web "搜索 DeepSeek 最新发布并总结"
node src/index.js --workspace ./scratch --docker "运行该目录里的测试"
node src/index.js --workspace ./scratch --allow-shell "运行该目录里的测试"
pnpm test
pnpm run eval
pnpm run eval --docker
```

CLI 可通过 `--session <ID>` 开始持久化会话，以 `--resume <ID>` 从 SQLite 恢复。默认数据库为 `.agent-harness/checkpoints.sqlite`，也可用 `--checkpoint-db <路径>` 指定。`src/agent/checkpointStore.js` 使用 Node 自带的 `node:sqlite`，将会话元数据与 checkpoint 快照写入事务；每次工具调用前记录运行中状态，结果返回后再记录工具消息。恢复时补全尚未收到结果的工具消息：运行中的调用标为结果未知，后续未启动的调用标为未执行，不直接重放。完成状态、回答及累计轮数也入库。checkpoint 只存消息，不单独存压缩计数；恢复时按消息里已有的「已省略」标记续算，因此不会因为恢复而重复丢弃。数据库保存完整消息与工具输出，不应放在 Agent 工作区内。

指定 `--project <ID>` 时，CLI 自动建立会话（也可显式指定 `--session`），在完成时将截短的任务、最终答复及工具名称写入 `memory_episodes`。会话完成状态与记忆记录在同一 SQLite 事务中写入。新任务只从同项目最近 200 条记录中做文字相关性排序，选最多三条，并限制注入长度；记录作为当前任务之前的用户参考消息提供给模型。历史答复未经过独立验收，提示中明确要求先核实；当前没有长期知识提炼、向量索引或中文分词服务。

`AGENT_MAX_TURNS`、`AGENT_MAX_DURATION_MS`、`AGENT_MAX_CONTEXT_CHARS`、`AGENT_KEEP_RECENT_TURNS`、`AGENT_DOCKER_PIDS` 为 CLI 的严格正整数配置，`AGENT_CONTEXT_SOFT_RATIO` 必须是 (0, 1] 之间的数值，`AGENT_MODEL_MAX_RETRIES` 必须是 0 到 5 之间的整数；沙箱另有 `AGENT_DOCKER_IMAGE`、`AGENT_DOCKER_MEMORY`、`AGENT_DOCKER_CPUS`、`AGENT_DOCKER_USER`、`AGENT_DOCKER_BINARY`。网络工具有 `WEB_SEARCH_PROVIDER`（`auto`/`tavily`/`bing`/`duckduckgo`）、`TAVILY_API_KEY`、`WEB_FETCH_TIMEOUT`、`WEB_FETCH_MAX_BYTES`、`WEB_FETCH_MAX_REDIRECTS`、`WEB_SEARCH_TIMEOUT`、`WEB_SEARCH_MAX_RESULTS`、`WEB_USER_AGENT`。工具层仍使用 `WORKSPACE_ROOT`、`SHELL_PATH`、`COMMAND_TIMEOUT`、`MAX_COMMAND_TIMEOUT`、`MAX_OUTPUT_CHARS`、`MAX_WRITE_CHARS`、`MAX_SEARCH_FILES`、`MAX_SEARCH_FILE_BYTES`；其中工具配置的环境变量解析仍采用 `parseInt(value) || default`，尚未统一验证。命令输出上限分别作用于 stdout 和 stderr，不是完整工具结果的硬上限。

离线测试包含假模型任务、本地 HTTP 服务端到端流程，以及网络工具的本地服务器/HTML 夹具；不需外网和真实密钥。Windows 真正的进程终止测试依赖系统允许 `taskkill`；拒绝时会报告终止失败。`withTimeout()` 仍只停止等待 Promise，不会取消底层操作；模型请求采用 SDK 的 `AbortSignal`。

`pnpm run eval` 使用真实模型，当前顺序运行八个纯文件任务、两个代码修复任务和一个需要 `--docker` 的沙箱任务（共十一项）。每项测评用 `mkdtemp` 创建独立工作区；文件任务只注册文件工具，不注册网络工具；代码任务在进程内后端下显式注册 `exec_command`，加 `--docker` 后所有命令一律进容器。检查器验证精确文件内容、目录集合、受保护夹具未修改、搜索和补丁工具调用、命令调用，并独立执行 `node --test`；`sweep-audit-weights` 还检查当前消息历史里保留的 `search_files` 查询，拒绝含 4 位以上连续数字的查询（防止用数字前缀逐位试探 weight；若未来 L4 丢弃早期对话，需把查询另行持久化）。模型返回 `completed` 只是必要条件，检查失败仍判为失败。声明 `requiresSandbox` 的任务在没有沙箱时直接判失败，不会静默跳过。用例可以声明 `maxTurns`、`maxDurationMs` 与 `maxContextChars` 覆盖默认预算，实际生效值记录在每条结果（JSON 报告的 `budget` 字段）里。预算从参考解法成本推导，而不是调到通过为止：`sweep-audit-weights` 的参考解法是逐个读取 24 个文件（本机 50–95 秒、8–12 轮），最初把轮数放到 16、耗时安全网放到 240 秒；2026-10-23 的 5 次复测有 4 次在 16 轮耗尽（读了 22–25 个文件仍未答完），因此把轮数改为「最坏情况一轮读一个」的 24，耗时仍为 240 秒（约 ×3）。这仍是按最坏读取成本推导的有界预算，不是按单次通过结果继续上调。`aggregate-audit-totals` 读取 12 个约 11KB 的模块，预算为 16 轮 / 240 秒；`repair-cross-file-contract` 使用默认 12 轮 / 120 秒。

`aggregate-audit-totals` 的审计行是「模块名 + 300–360 位十六进制封条 + 行末 8 位十进制 weight」，12 个模块分布在四个区域目录，目标文件为 `src/services/jobs/jobs-1.js`（weight `96482731`），总和 `739950220`；检查器要求回答同时含路径、`TOTAL=` 数值，且 13 个夹具文件逐字节未变。它只验证「逐个读取并汇总」，不检查读取策略，因此模型仍可用检索试探；sweep 已增加数字检索检查，但 aggregate 还没有同类约束。`repair-cross-file-contract` 的夹具包含 `src/math.js`、`src/report.js` 与 `test/report.test.js`，两处错误分别是乘法写成加法、`factor + 1` 偏移一位；检查器要求两个源码精确修复、配置与测试未改、独立 `node --test` 通过，并确认 Agent 真的调用过 `exec_command`。

`--repeat` 最多允许 20 轮。每次命令把汇总、逐项检查和不含工具参数的事件写入 `eval-results/<timestamp>.json`；该目录不入库。默认清理工作区，`--keep-workspaces` 会保留并打印路径。报告当前为 `schemaVersion: 2`：每条结果增加 `toolCounts`（按工具名计数）和 `compression`（`compactionCount`、`omittedFiles`、`rereadFiles`、`rereadRate`、`omittedToolResults`、`rereadCalls`）；顶层 `summary.compression` 增加按「文件-轮次」聚合的 `runsWithCompaction`、`omittedFiles`、`rereadFiles`、`rereadRate`、`omittedToolResults` 与 `contextLimitRuns`。首个真实基线和异常记录见 [EVALUATION.md](./EVALUATION.md)。

## 7. 尚未完成的 M1 验收

- 扩充不同难度的代码夹具，让上下文压力在真实任务里出现，再通过重复运行判断当前小样本是否能在更长时间窗口保持稳定。
- 根据真实任务的轨迹判断压缩策略是否伤害结果：运行层现在会记录「这次压缩整条省略了哪些文件的读取结果」，并在模型重读时发 `reread` 事件；停止结果和 JSON 报告都带省略/重读计数与比例（2026-10-23 已实现，离线测试覆盖）。2026-10-23 的 aggregate 复测 3/3，三次都触发压缩，其中一次走到 L3+L4、整条省略 6 条目录结果；但没有 `read_file` 结果被整条省略，`omittedFiles` 与 `rereadFiles` 均为 0。把 aggregate 的上下文预算临时压到 30000 字符复测 3 次（2/3）：其中两次分别整条省略 12 与 13 个文件，并各重读 12 个。随后用 24 个约 1.9KB 的模块尝试固定用例：24 求和（20 轮）1/3；允许写 `notes.md` 后 0/3；只问首/中/尾（16 轮）2/3，但第三次只读 3 个点名文件、未触发压缩；24 模块找最大值（16 轮）0/3；压到 8 模块（12 轮）仍 0/3。低预算下模型丢失累计值后反复重读，加轮数、允许笔记、缩小文件集都没有消除循环，因此 `recall-after-compaction` 已删除，没有升为固定用例。文件级「省略 → 重读」确实发生；若要把 L3/L4 固定成基线，应先改变 Agent 的记忆方式（持久 scratchpad/摘要），而不是继续换夹具。
- 根据真实任务的轨迹决定是否需要更精确的 token 预算、流式进度及厂商差异处理。
- 运行 `explore-large-repo` 与 `sweep-audit-weights` 的分布：前者修复后 5/5 通过（3 轮、约 3 秒），说明点名常量的检索路径不构成上下文压力；后者旧夹具 25 次运行答对 15 次，10 次失败全部来自耗时或轮数预算，没有上下文超限。用例现在各自声明轮数与耗时安全网（sweep 为 24 轮 / 240 秒），实际值记入报告。2026-10-21 已加固 sweep 夹具：审计行改为「模块名 + 300–360 位十六进制封条 + 行末 8 位十进制 weight」，去掉 `"weight":` 可检索键，封条长度逐模块变化且末位固定为字母；`search_files` 的预览看不到 weight，但匹配发生在整行，仍可用数字前缀试探。离线夹具测试与假模型用例已通过；加固后用真实模型复测 10 次（4/10，6 次失败全部是轮数耗尽，失败时读了 20–25 个文件），没有 `context_limit`；其中一次通过只读 8 个文件却发了 26 次 `search_files`，不能排除数值前缀试探。2026-10-23 在 16 轮下复测 5 次仅 1/5；改为 24 轮后 5 次为 4/5，唯一失败在 24 轮里只读了 21 个文件、列了 8 次目录。2026-10-23 已修 oracle：sweep 检查器拒绝含 4 位以上连续数字的 `search_files` 查询；修复后复测 5 次仍为 4/5，唯一失败是查询 `"ed64210000"` 被检查器拒绝，其余 4 次都在 12–21 轮内逐个读取完成，没有 `max_turns`。数字旁路已收口，但非数字定位仍可能，且 4/5 样本仍小；子 Agent 是否引入仍按 D14 的准入条件判断（见 [DESIGN.md](./DESIGN.md) D14）。
