# agent-harness

一个用于学习和验证 coding agent 基础结构的 Node.js 项目。现在可以通过 OpenAI 兼容的 Chat Completions 接口运行**有轮数、耗时和上下文预算上限的单 Agent**：模型选择工具，程序校验并执行工具，再把结果按调用 ID 回传。上下文达到软阈值会先压缩历史，压缩后仍超硬预算才终止。运行仍限于可信、受控的任务目录。

## 运行一个任务

需要 Node.js 22.13+ 和 pnpm 11.10+。安装依赖后，将 `.env.example` 复制为 `.env`，填写 `MODEL_NAME`、`MODEL_API_KEY`；连接其他兼容服务时填写 `MODEL_BASE_URL`（通常以 `/v1` 结尾）。也接受对应的 `OPENAI_MODEL`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`。CLI 从当前目录加载 `.env`。

```bash
pnpm install
node src/index.js --workspace ./scratch "在 result.txt 中写入 hello"
```

先自行创建 `scratch`，并把任务文件放进去。CLI 要求显式指定工作区，且拒绝工作区根目录中的 `.env`。默认提供 `read_file`、`list_directory`、`search_files`、`apply_patch`、`write_file`；需要运行命令时有两个互斥的后端：

```bash
node src/index.js --workspace ./scratch --docker "运行该目录里的测试"      # 容器沙箱，推荐
node src/index.js --workspace ./scratch --allow-shell "运行该目录里的测试" # 进程内直跑，仅限可信目录
```

`--docker` 在一次性容器里执行命令：只挂载工作区、根文件系统只读、没有网络、命令结束即删除容器。拿不到 Docker 或镜像时程序直接退出，不会退化成无隔离执行。`--allow-shell` 是进程内直接执行，没有进程沙箱，能访问工作区外的资源，也可能读取磁盘上的凭据文件。详细边界见 [约束文档](docs/CONSTRAINTS.md)。

模型服务必须支持 Chat Completions 的结构化工具调用；只支持纯文本聊天的兼容接口无法完成文件任务。当前实现不使用 Responses API，也不提供流式输出。

## 会话与 checkpoint

需要中断后继续时，首次运行指定唯一会话 ID；恢复时使用相同 ID：

```bash
node src/index.js --workspace ./scratch --session demo "在 result.txt 中写入 hello"
node src/index.js --resume demo
```

会话默认保存在当前目录的 `.agent-harness/checkpoints.sqlite`，该目录已被 Git 忽略。若使用 `--checkpoint-db <路径>` 指定其他 SQLite 文件，首次运行和恢复时都要指定同一路径。数据库必须位于 Agent 工作区之外，因为它包含完整消息和工具结果。未指定 `--session` 时，原有一次性运行方式不变。

每次工具调用前后都会保存 checkpoint；恢复会沿用原任务、工作区和 shell 权限。若上次在工具执行期间中断，程序不会自动重放该调用，而是把“结果未知”反馈给模型，供它先检查工作区。checkpoint 不回滚文件或命令的副作用。轮数上限跨恢复累计；达到上限后，可调高 `AGENT_MAX_TURNS` 再恢复。已完成的会话不能再次恢复。

## 情景记忆（首版）

给不同任务指定同一个项目 ID，即可在新任务开始时参考该项目此前完成的任务记录：

```bash
node src/index.js --workspace ./scratch-1 --project my-app "确认 retryCount 的配置位置"
node src/index.js --workspace ./scratch-2 --project my-app "将 retryCount 改为 3"
```

`--project` 会自动创建会话并在终端打印 ID；也可同时用 `--session <ID>` 自行命名。记忆与 checkpoint 共用 SQLite 数据库。每条记录包含原任务、截短的最终答复、工具名称和来源会话；只保存状态为 `completed` 的任务。新任务按文字相关性选取最多三条记录，总注入长度有上限。不同项目 ID 的记录互不检索；不指定 `--project` 时不启用情景记忆。

最终答复尚无独立的通用验收器，因此历史记录会明确标记为**未经独立核实的参考资料**。Agent 应先检查当前工作区，再决定是否采用其中的结论。当前实现没有长期知识提炼、向量检索或自动更新记忆；固定离线对照用例验证了同项目检索、跨项目隔离及最终文件差异。

## 上下文预算与压缩

消息和工具定义按序列化字符数计算预算（不是 token 计数）。达到硬预算的 70% 时先压缩历史，压缩后仍超硬预算才终止任务：

```text
L1 用工具声明的 compact 处理器截断长结果  →  L2 把上限收严  →  L3 旧结果换成引用  →  L4 丢弃整段早期历史
```

压缩不拆散「工具调用 ↔ 工具结果」的配对，也不动 system 消息、原始任务和最近两次交换；被省略的内容会留下可读标记，模型可据此重读文件。运行时会打印每次压缩的级别、省下的字符和估算 token。

## 并发执行与重试

模型经常在一轮里同时发出多个调用（例如一次读三个文件）。这些调用会并发执行，但同一路径上的调用仍串行——否则两个 `apply_patch` 改同一文件时，后写的会静默覆盖前一次。结果顺序始终与模型给出的调用顺序一致，运行时在并发时打印「N 个工具调用并发执行」。

模型请求失败会按 `AGENT_MODEL_MAX_RETRIES` 重试（默认 2 次，指数退避）。重试只放在模型层：模型请求幂等，而工具可能有副作用，自动重试等于重复执行。

## 配置与测试

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `AGENT_MAX_TURNS` | 12 | 最多模型请求轮数 |
| `AGENT_MAX_DURATION_MS` | 120000 | 整次任务的耗时上限 |
| `AGENT_MAX_CONTEXT_CHARS` | 120000 | 消息和工具定义的字符预算；不是精确 token 预算 |
| `AGENT_CONTEXT_SOFT_RATIO` | 0.7 | 达到硬预算的该比例时先压缩历史 |
| `AGENT_KEEP_RECENT_TURNS` | 2 | 不参与压缩的最近交换数 |
| `AGENT_MODEL_MAX_RETRIES` | 2 | 模型请求重试次数，0 到 5 |
| `AGENT_DOCKER_IMAGE` | `node:22-alpine` | 沙箱使用的镜像；必须是本地已有镜像 |
| `AGENT_DOCKER_MEMORY` | `1g` | 容器内存上限 |
| `AGENT_DOCKER_CPUS` | `1` | 容器 CPU 上限 |
| `AGENT_DOCKER_PIDS` | 256 | 容器进程数上限，防 fork 炸弹 |
| `AGENT_DOCKER_USER` | `0:0` | 容器内运行用户；工作区需对该用户可写 |

```bash
pnpm test
```

Windows PowerShell 若阻止 `pnpm.ps1`，可使用 `pnpm.cmd`。测试不使用真实 API Key：假模型验证多轮工具调用，本地 HTTP 服务验证 CLI 和兼容接口。沙箱的隔离断言（工作区可写、根只读、无网络、容器被删除）会在本机 Docker 与镜像可用时真实执行，否则跳过并说明原因。Windows 上的真实进程终止用例需要 `taskkill` 权限；若系统拒绝，工具会报告终止失败。

## 运行固定测评

固定测评会调用 `.env` 中配置的真实模型，因此会产生对应服务的请求和费用。每个任务使用独立的系统临时目录；文件类任务只开放文件工具，加 `--docker` 后命令一律进容器沙箱。程序根据最终文件判定结果，不采信模型的“已完成”声明。

```bash
pnpm run eval                              # 运行全部测评并保存 JSON 报告
pnpm run eval --docker                     # 命令在容器沙箱内执行（推荐）
pnpm run eval --repeat 3                   # 连续运行三轮
pnpm run eval --list                       # 查看测评名称
pnpm run eval --case create-exact-file
pnpm run eval --keep-workspaces            # 保留临时目录供人工检查
```

当前有九个固定任务：精确创建文件、读取并转换已有文件、搜索并局部修改文件、修复代码并运行测试、在 75KB 级合成源码中定位并修改单个设置、跨多个文件检索唯一答案、**在含 60 个模块的仓库里定位唯一端点常量**、**在 24 个大型模块中比对配置权重**，以及**在容器沙箱里修复代码并验证网络隔离**。最后一项只有在 `--docker` 模式下可解，没有沙箱时会明确判失败。前四个有 12/12 的历史基线；第五至第八项用于制造真实的上下文压力与检索路径，让压缩和定向检索能被轨迹检验；其中第七项是判断是否需要子 Agent 的准入实验（见 [DESIGN.md](docs/DESIGN.md) D14），第八项要求逐个读取合计约 134KB 的模块，10 次真实运行答对 7 次，失败全部来自耗时或轮数预算而非上下文超限。输出会显示每项检查、模型轮数、耗时和总通过率，JSON 报告写入被 Git 忽略的 `eval-results/`。默认在测评结束后清理临时目录。真实基线见 [固定测评文档](docs/EVALUATION.md)。

## 当前工具与限制

| 工具 | 能力 | 主要边界 |
|---|---|---|
| `exec_command` | 执行 shell 命令，返回 stdout、stderr 和退出状态 | CLI 默认不注册；两个后端：`--docker` 进容器（有隔离），`--allow-shell` 进程内直跑（无隔离） |
| `read_file` | 读取 UTF-8 文本 | 检查真实路径，拒绝无效 UTF-8 和二进制内容，截断长内容 |
| `list_directory` | 列出目录的直接子项 | 检查真实路径，限制列表长度 |
| `search_files` | 递归搜索字面量文本，返回文件和行列位置 | 跳过链接、二进制、大文件、`.git` 和 `node_modules`；限制文件数和结果长度 |
| `apply_patch` | 对现有文本文件执行一组精确替换 | 默认要求旧文本唯一匹配；全部修改成功后才原子替换；限制文件与补丁大小 |
| `write_file` | 写入 UTF-8 文本 | 默认拒绝覆盖，覆盖须显式指定；限制写入大小 |

M1 首版已经跑通：真实模型可完成文件任务和小型代码修复。最早四个固定任务连续 3 轮取得 12/12 通过；之后新增的上下文压力、跨文件检索、沙箱与大面积探索任务各有单次或小样本真实运行。大面积探索的两项分别检验「检索定位」与「必须通读」：60 模块任务仍未有真实轨迹，24 模块任务 10 次运行答对 7 次。离线测试 105 项，2026-10-19 在干净工作区全绿（含两条真实 Docker 沙箱隔离断言），覆盖工具协议、恢复、记忆、四级上下文压缩、同轮并发与容器沙箱。后续改动应重复运行当前测评，观察成功率、轮数和失败模式是否退化。子 Agent 与规划器按 [DESIGN.md](docs/DESIGN.md) D14 暂缓，准入条件写在该节。目标见 [GOALS.md](docs/GOALS.md)，代码流程见 [TECHNICAL.md](docs/TECHNICAL.md)，设计取舍见 [DESIGN.md](docs/DESIGN.md)。
