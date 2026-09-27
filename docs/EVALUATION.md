# 固定测评与基线

> 固定测评使用真实模型，会产生接口请求和费用。完整单次报告保存在本地 `eval-results/`，其中不记录 API Key、工具参数或文件内容；该目录不进入 Git。

## 当前任务

| ID | 能力 | 确定性检查 |
|---|---|---|
| `create-exact-file` | 创建并复查精确内容的文件 | 内容严格等于 `hello`，根目录无多余文件 |
| `transform-existing-file` | 读取、转换并复查已有文件 | 输入未修改，输出严格匹配，根目录无多余文件 |
| `search-and-patch` | 搜索并局部修改已有文件 | Agent 使用 `search_files` 和 `apply_patch`，未调用 `write_file`，目标精确修改，受保护文件与目录结构不变 |
| `repair-code-and-test` | 读取源码和测试、修复代码、运行命令 | 配置与测试未修改，Agent 调用过 `exec_command`，独立执行 `node --test` 通过，无多余文件 |

三个文件任务不开放 shell。代码修复任务只在程序创建的一次性临时夹具中开放 `exec_command`；这仍不是进程沙箱，不能用于不可信仓库。

## 2026-09-27 初始三任务基线

下面是增加 `search-and-patch` 之前的首个基线；它保留用于对照，但不覆盖当前四项任务。

- 模型：`deepseek-v4-flash`
- 运行方式：3 个任务连续运行 3 轮，共 9 个任务
- 结果：9/9 通过，任务成功率 100%

| 任务 | 通过 | 平均模型轮数 | 平均耗时 |
|---|---:|---:|---:|
| `create-exact-file` | 3/3 | 3.67 | 3071 ms |
| `transform-existing-file` | 3/3 | 4.00 | 4505 ms |
| `repair-code-and-test` | 3/3 | 5.67 | 5166 ms |

没有最终失败案例。观察到两个可恢复过程失败：

- 第三轮 `create-exact-file` 首次调用 `list_directory` 时参数无效，模型收到错误后在下一轮改用合法参数并完成任务。
- 第三轮 `repair-code-and-test` 在修改源码前先运行测试，测试按夹具设计失败；模型随后修改源码并再次运行测试，最终通过独立检查。

这些轨迹说明错误回传和恢复路径有效，也说明 3 次样本只能作为首个基线，不能证明长期稳定性。

对应本地报告：`eval-results/2026-09-27T08-53-53-860Z.json`。

## 2026-09-27 五文件工具基线

增加 `search_files`、`apply_patch` 和对应固定任务后，重新运行当前全部任务：

- 模型：`deepseek-v4-flash`
- 运行方式：4 个任务连续运行 3 轮，共 12 个任务
- 结果：12/12 通过，任务成功率 100%

| 任务 | 通过 | 平均模型轮数 | 平均耗时 |
|---|---:|---:|---:|
| `create-exact-file` | 3/3 | 3.33 | 3402 ms |
| `transform-existing-file` | 3/3 | 4.00 | 3797 ms |
| `search-and-patch` | 3/3 | 5.00 | 4710 ms |
| `repair-code-and-test` | 3/3 | 5.33 | 4892 ms |

新任务三轮均按 `search_files`、`read_file`、`apply_patch`、`read_file` 的顺序完成，没有使用 `write_file`，目标文件和受保护文件均通过精确检查。旧的代码修复任务也在三轮中使用 `apply_patch` 完成局部修改。

没有最终失败案例。观察到两个可恢复过程失败：

- 第一轮 `transform-existing-file` 同时调用读取和目录工具时给 `list_directory` 提供了无效参数；错误回传后仍在后续轮次完成任务。
- 第一轮 `repair-code-and-test` 在修改源码前先运行了失败测试，随后使用 `apply_patch` 修复源码并再次运行测试通过。

对应本地报告：`eval-results/2026-09-27T13-37-43-574Z.json`。

## 运行方式

```bash
pnpm run eval --repeat 3
pnpm run eval --case repair-code-and-test --repeat 3
pnpm run eval --keep-workspaces
```

每次运行都会生成带时间戳的 JSON 报告，包含通过率、检查结果、轮数、耗时及不含参数内容的模型与工具事件。若出现失败，先依据报告确定是模型终止、工具协议、文件状态还是独立测试失败；需要检查现场时再使用 `--keep-workspaces`。
