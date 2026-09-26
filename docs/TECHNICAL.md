# 技术文档

> 回答「用什么技术、怎么组织、怎么跑」。
> 技术选型的**理由**见 [DESIGN.md](./DESIGN.md)，不可逾越的规则见 [CONSTRAINTS.md](./CONSTRAINTS.md)。

---

## 一、技术栈

| 层 | 选型 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Node.js（ESM，`"type": "module"`） | ≥ 20 | 不用 CommonJS；`node:test` 需要 Node 20+ |
| 包管理 | pnpm | ≥ 8（推荐 ≥ 11.10） | `engines` / `devEngines` 显式拒绝 npm 与 Yarn |
| 参数校验 | zod | `^4.4.3` | 工具入参校验；后续用 `z.toJSONSchema()` 转给模型 |
| 测试 | `node:test` + `node:assert`（内置） | Node 20+ | **零测试框架依赖**，见 D7 |
| Agent 内核 | 自研 | — | 项目的核心目的就是自己实现它 |
| 模型接入 | **待定**（M1 决定） | — | 候选见文末「待确定的技术问题」 |

当前**运行时依赖只有 zod 一个**。这是刻意的，见 [CONSTRAINTS.md](./CONSTRAINTS.md) § 4.1。

---

## 二、项目结构

`✅` = 已实现，`⬜` = 规划中（括号内是里程碑）。

```
agent-harness/
├── src/
│   ├── config.js              ✅ 集中配置：工作区根、shell、超时、输出上限
│   ├── safety/
│   │   ├── sandbox.js         ✅ 工作区路径边界
│   │   └── timeout.js         ✅ 通用超时包装
│   ├── tools/
│   │   ├── registry.js        ✅ 工具注册表 + 结果处理器路由
│   │   ├── execCommand.js     ✅ 命令执行（沙箱 + 超时 + 捕获输出）
│   │   ├── filePaths.js       ✅ 文件工具的真实路径边界
│   │   ├── readFile.js        ✅ 读取 UTF-8 文本
│   │   ├── listDirectory.js   ✅ 列出目录直接子项
│   │   ├── writeFile.js       ✅ 创建或明确覆盖文本文件
│   │   └── index.js           ✅ 内置工具组装
│   ├── agent/                 ⬜ (M1) ReAct 主循环
│   ├── memory/                ⬜ (M2) 会话内 / 跨会话记忆
│   ├── rag/                   ⬜ (M3) 检索
│   ├── skills/                ⬜ (M5) 技能加载与选择
│   └── observability/         ⬜ (M6) token 计量 / 成本 / 调用 trace
├── test/
│   ├── sandbox.test.js        ✅
│   ├── timeout.test.js        ✅
│   ├── execCommand.test.js    ✅
│   └── fileTools.test.js      ✅
├── docs/                      ← 本目录
│   ├── GOALS.md
│   ├── TECHNICAL.md
│   ├── DESIGN.md
│   └── CONSTRAINTS.md
├── package.json
└── README.md
```

**两个刻意的结构选择：**

- **`safety/` 和未来的 `observability/` 是横切层**，不属于任何业务模块。
  「能用」与「demo」的结构性差别就在这里：底座是独立的层，而不是散落在各处的几行防御代码。
- **文档放在 `docs/`，不散落在根目录**。四份文档职责分明，互相交叉引用。

---

## 三、模块职责与依赖

```
                    ┌──────────┐
                    │ config   │  ← 所有模块的叶子依赖，不反向依赖任何模块
                    └────┬─────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
   ┌─────────────┐              ┌─────────────┐
   │  safety     │◄─────────────│   tools     │
   │ sandbox     │              │  registry   │
   │ timeout     │              │  execCommand│
   └─────────────┘              └──────┬──────┘
                                       │
                                       ▼
                                ┌─────────────┐
                                │   agent     │  (M1)
                                └──────┬──────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    ▼                  ▼                  ▼
             ┌───────────┐      ┌───────────┐      ┌───────────┐
             │ memory    │      │ skills    │      │ rag       │
             │  (M2)     │      │  (M5)     │      │  (M3)     │
             └───────────┘      └───────────┘      └───────────┘
```

**依赖原则：**

1. `config` 是叶子 —— 它不 import 任何业务模块（只依赖 logger 与 Node 内置模块）
2. `safety` 不依赖 `tools` —— 沙箱和超时是通用能力，工具来使用它们，而不是反过来
3. `tools` 不依赖 `agent` —— 工具能被独立测试，不需要启动 Agent
4. `memory` / `rag` / `skills` 平级，互不依赖 —— 它们都只依赖 `agent` 提供的上下文接口

第 3 条是 M0 能先做出来的前提：工具层可以完全独立地开发和测试。

---

## 四、核心数据流

### 4.1 工具调用流（当前）

```
调用方（测试 / 未来的 Agent）
   │
   ▼
registry.invoke(name, args)
   ├─ 查表失败 ────────→ 返回「工具 "x" 不存在。可用工具: ...」
   ├─ schema 校验失败 ─→ 返回「工具 "x" 参数不合法: ...」
   └─ 通过
        ▼
   tool.invoke(parsedArgs)          ← 工具自身永不抛错
        │
        ├─ exec_command：
        │     ├─ 1. sandbox.resolveInWorkspace(cwd)   越界 → 返回「命令未执行 —— ...」
        │     ├─ 2. resolveTimeoutMs(timeout, 上限)   封顶
        │     ├─ 3. spawn(command, { shell, pipe })
        │     ├─ 4. 累积 stdout/stderr（切片截断）
        │     ├─ 5. 超时 → killTree，检查终止结果；失败时返回错误
        │     └─ 6. formatResult → 字符串
        │
        └─ 任何异常 ─────→ 「工具 "x" 执行出错: ...」
   │
   ▼
字符串结果（模型可读）
   │
   ├─ registry.getProcessor(name).compact(result)     → 给模型的（可截断）
   └─ registry.getProcessor(name).summarize(result)   → 给终端的（一行）
```

**关键点**：`invoke` 的返回类型永远是 `string`。
所有失败路径（找不到工具、参数错、执行错）都汇成字符串，这样 Agent 循环里不需要写 try/catch。

文件工具同样通过注册表调用。读取和列目录会校验目标的真实路径；写入会校验父目录的真实路径，默认拒绝覆盖，显式覆盖时先写临时文件再替换。读取、列目录和写入都设有长度上限。

### 4.2 ReAct 主循环（M1 规划）

```
messages = [system, human(task)]
loop（最多 maxIterations 次）：
   1. 模型调用（携带工具的 JSON Schema）
   2. 若返回 tool_calls：
        for each call: registry.invoke(name, args) → ToolMessage
        继续 loop
   3. 若返回纯文本：
        结束，返回文本
```

与 `min-cursor` 的差别：这里会在循环中**显式做上下文预算检查**，
而不是等到 token 溢出才被动压缩。

---

## 五、配置项

全部通过环境变量覆盖，默认值定义在 [src/config.js](../src/config.js)：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WORKSPACE_ROOT` | 仓库根目录 | 沙箱边界；真实使用时指向「让 Agent 操作的那个项目」 |
| `SHELL_PATH` | 自动探测 Git Bash，找不到则用系统默认 shell | 命令执行使用的 shell |
| `COMMAND_TIMEOUT` | `30000` | 单条命令默认超时（毫秒） |
| `MAX_COMMAND_TIMEOUT` | `600000` | 模型可指定的超时上限（毫秒），**必须封顶** |
| `MAX_OUTPUT_CHARS` | `8000` | 命令、读文件与列目录返回内容的最大字符数 |
| `MAX_WRITE_CHARS` | `100000` | 单次写入文本的最大字符数 |

上限的取值理由与约束见 [CONSTRAINTS.md](./CONSTRAINTS.md) § 5。

---

## 六、常用命令

```powershell
pnpm install       # 安装依赖
pnpm test          # 跑全部测试（node --test）
pnpm test:watch    # 监听模式
```

**单独跑某个测试文件**：

```powershell
node --test test/sandbox.test.js
```

**手动验证超时确实杀掉了进程**（测试断言迅速返回，仍需手动检查残留进程）：

```powershell
node -e "
import('./src/tools/execCommand.js').then(async (m) => {
  const { execSync } = await import('node:child_process');
  const tool = m.createExecCommandTool({
    workspaceRoot: process.cwd(), shell: true,
    defaultTimeoutMs: 1000, maxTimeoutMs: 5000, maxOutputChars: 1000,
  });
  const out = await tool.invoke({ command: 'sleep 37', timeoutMs: 300 });
  console.log(out.split('\n')[0]);
  await new Promise((r) => setTimeout(r, 800));
  const ps = execSync('ps -W', { encoding: 'utf8' });
  console.log('残留进程:', ps.split('\n').filter((l) => l.includes('sleep 37')).length);
});
"
```

预期：第一行是超时信息，最后一行残留进程数为 `0`。

---

## 七、现有实现对照

| 文件 | 职责 | 对外接口 |
|---|---|---|
| `src/config.js` | 集中配置 | `config`（对象） |
| `src/safety/sandbox.js` | 路径边界 | `resolveInWorkspace` / `isInWorkspace` / `SandboxError` |
| `src/safety/timeout.js` | 通用超时 | `withTimeout` / `TimeoutError` |
| `src/tools/registry.js` | 工具注册与路由 | `ToolRegistry` 类 |
| `src/tools/execCommand.js` | 命令执行 | `createExecCommandTool` / `resolveTimeoutMs` |
| `src/tools/filePaths.js` | 文件工具真实路径边界 | `resolveExistingPath` / `resolveWritePath` |
| `src/tools/readFile.js` | 读取文本 | `createReadFileTool` |
| `src/tools/listDirectory.js` | 列出目录 | `createListDirectoryTool` |
| `src/tools/writeFile.js` | 写入文本 | `createWriteFileTool` |
| `src/tools/index.js` | 工具组装 | `createToolRegistry` |

测试覆盖：35 个用例，分布为 sandbox 10 / timeout 5 / execCommand 13 / fileTools 7。

---

## 八、待确定的技术问题

这些会在对应里程碑开始时决定，**现在不提前锁定**：

| 问题 | 何时决定 | 候选 | 关注点 |
|---|---|---|---|
| 模型接入方式 | M1 | 官方 `openai` SDK / 直接 `fetch` / `@langchain/openai` | 薄封装的可观测性 vs 少写代码 |
| 记忆的存储载体 | M2 | SQLite / 本地文件 / PostgreSQL | 零依赖启动 vs 复用已有 pg 经验 |
| 沙箱是否升级到容器 | M4 之后 | Docker / 保持路径校验 | 隔离强度 vs 使用门槛 |
| planning 的实现形式 | M1 之后 | 显式计划层 / 提示词引导 | 可控性 vs 复杂度 |

---

## 九、与其它仓库的关系

- **`min-cursor`**（AI coding agent）：harness 的设计依据之一。
  它踩过的坑（`stdio: 'inherit'` 导致模型看不到命令输出、
  `if (toolName === ...)` 导致新增工具要改多处）直接变成了本项目的 D3 和 D5。
- **`rag`**（独立的 RAG 项目）：M3 的参考实现，
  它已验证了抓取 → 切分 → 向量化 → 带引用回答的完整链路。

两个仓库都不直接被本仓库 import —— 见 [GOALS.md](./GOALS.md) 的「共享经验，不共享代码」。
