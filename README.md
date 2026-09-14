# agent-harness

从零构建的 Agent 骨架。目标不是跑通一个 demo，而是做出**真正能用的 agent**。

## 为什么先做底座

一个能跑的 ReAct 循环很好写，难的是让它**敢被交出去自己跑**。三个最容易漏掉的点：

1. **超时** —— 没有它，一条 `sleep 999` 就能让 agent 永久挂住
2. **沙箱** —— 没有它，模型生成的一个 `../` 就能写到工作区外
3. **测试** —— 没有它，上面两条改一次就可能悄悄失效

所以这个仓的第一批代码不是 Agent 循环，而是这三件事。事实也证明了这一点：本仓的第一个真实 bug（输出截断失效）就是测试抓出来的，而不是靠肉眼看代码发现的。

## 当前进度

- [x] 项目骨架（ESM + 内置 `node:test`，零测试框架依赖）
- [x] `src/safety/sandbox.js` — 工作区路径边界
- [x] `src/safety/timeout.js` — 通用超时包装
- [x] `src/tools/registry.js` — 工具注册表 + 结果处理器路由
- [x] `src/tools/execCommand.js` — 沙箱约束 + 超时杀进程树 + 捕获 stdout/stderr
- [ ] LLM 接入与 ReAct 循环
- [ ] 文件类工具（read_file / write_file / list_directory）
- [ ] 会话内记忆 → 跨会话记忆
- [ ] RAG 检索接入
- [ ] 子 agent（subagent）
- [ ] 技能（skill）加载与选择

## 三个设计决定

### 1. 超时 ≠ 停止等待

`Promise.race` 只是「不再等」，子进程仍然在后台占着 CPU 和端口。
所以这里走的是 `setTimeout` + `killTree`：Windows 用 `taskkill /pid <pid> /t /f` 杀整棵进程树，
POSIX 用 `SIGKILL`。少了这一半，"超时保护"就只是个假象。

### 2. 命令输出必须回到模型手里

用 `stdio: 'inherit'` 时输出只打在终端上，**模型看不到** —— 它执行完 `ls` 拿不到任何文件名，
执行完 `git status` 不知道仓库脏不脏，只能靠编。
这里改成 pipe 捕获，把 stdout / stderr / 退出码一起返回，并设了输出上限防止一次撑爆上下文。

### 3. 沙箱只管路径，不管进程

`resolveInWorkspace` 拦得住 `../` 逃逸和越界的绝对路径，但拦不住命令本身 ——
`exec_command` 走的是 shell，可以在系统任意位置读写。真正的进程级隔离需要容器
（Docker / Firejail / Windows Sandbox）。
所以这一层的作用是**拦住模型走错路，而不是拦住恶意代码**。

## 运行

```bash
pnpm install
pnpm test          # node --test
pnpm test:watch
```

## 目录

```
src/
├── config.js              # 集中配置（工作区根、shell、超时、输出上限）
├── safety/
│   ├── sandbox.js         # 路径边界
│   └── timeout.js         # 通用超时
└── tools/
    ├── registry.js        # 工具注册 + 结果处理器路由
    ├── execCommand.js     # 命令执行（沙箱 + 超时 + 捕获输出）
    └── index.js           # 内置工具组装
test/
├── sandbox.test.js
├── timeout.test.js
└── execCommand.test.js
```
