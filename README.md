# agent-harness

一个用于学习和验证 coding agent 基础结构的 Node.js 项目。当前仓库**只有工具层**：模型接入、Agent 运行循环和 CLI 尚未实现，因此现在还不能接收任务并自主完成它。

## 当前能做什么

| 工具 | 能力 | 主要边界 |
|---|---|---|
| `exec_command` | 执行 shell 命令，返回 stdout、stderr 和退出状态 | 限制工作目录、执行时间和返回长度；**不限制命令访问工作区外的资源** |
| `read_file` | 读取 UTF-8 文本 | 检查真实路径，拒绝含 NUL 或无效 UTF-8 的内容，截断长内容 |
| `list_directory` | 列出目录的直接子项 | 检查真实路径，限制列表长度 |
| `write_file` | 写入 UTF-8 文本 | 检查父目录真实路径；默认拒绝覆盖，覆盖须显式指定；限制写入大小 |

`src/safety/sandbox.js` 是**路径检查器**，不是进程沙箱。文件工具额外解析真实路径以拦截指向工作区外的链接；`exec_command` 仍通过 shell 运行任意命令。不要把当前工具集当作可在不可信环境中无人值守运行的隔离系统。详细边界见 [约束文档](docs/CONSTRAINTS.md)。

## 运行测试

需要 Node.js 20+ 和 pnpm。仓库没有可运行的 Agent 入口。

```bash
pnpm install
pnpm test
```

Windows PowerShell 若阻止 `pnpm.ps1`，可以运行 `pnpm.cmd test`。Windows 上的真实进程终止测试需要 `taskkill` 权限；受限环境拒绝终止进程时，该用例会失败，工具会报告终止失败。

## 下一阶段

先实现**结构化工具调用的单 Agent 循环**：模型适配层、工具调用与结果回传、轮数和耗时上限、停止条件、可检查的执行记录，以及用假模型运行的离线测试。经典 ReAct 的 `Thought/Action/Observation` 文本格式不是接口要求。当前设计与待解决问题见 [技术文档](docs/TECHNICAL.md)。

## 文档导航

- [目标与验收](docs/GOALS.md)：项目目的、当前进度、下一阶段的完成标准。
- [架构与运行](docs/TECHNICAL.md)：实际代码结构、数据流、配置、测试及已知缺口。
- [设计决策](docs/DESIGN.md)：为什么采用当前工具与 Agent 结构，哪些决定仍待验证。
- [约束与边界](docs/CONSTRAINTS.md)：安全边界、资源上限、开发规则。
