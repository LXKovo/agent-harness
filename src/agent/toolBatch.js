/**
 * 一轮里的多个工具调用怎么执行
 *
 * 背景：模型经常在一轮里同时发出 2–3 个调用（真实轨迹里 10 轮有 7 轮如此）。
 * 原先逐条 await，等于把「各读一个文件」这种本来就独立的等待叠起来。
 * 这里改成同轮并发，但保留三条确定性保证：
 *
 *   1. 消息与事件的顺序不变 —— 并发只负责「执行」，
 *      追加 tool 消息、写 checkpoint、发事件统一按模型给出调用顺序做。
 *   2. 同一路径的调用串行 —— 两个 apply_patch 写同一个文件时，
 *      若都读到旧内容再各自原子替换，后写的那次会静默覆盖前一次。
 *   3. checkpoint 粒度仍是「一条调用」——
 *      每条各自写 tool_running 与 tool_batch，于是崩溃恢复时
 *      只有正在飞的那一个会被标为「结果未知」。
 */

/** 从工具参数里取出这次调用会碰到的路径；取不到就返回 null（视为可并发） */
export function pathOf(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  for (const key of ['filePath', 'cwd', 'path']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return `${key}:${value.trim()}`;
  }
  return null;
}

/**
 * 划分执行阶段（规则说明与测试基准）
 *
 * 规则只有一条：**每条调用放进「它自己那个路径」的下一个可用阶段**。
 * 于是同一路径的调用天然串行，而互不相关的调用可以落在同一阶段并行。
 *
 * 注意：runToolBatch 实际执行时用的是「按路径的串行链」，不是先划分阶段再并行。
 * 两者语义相同，但阶段划分会让后建立的阶段整体等待前一个阶段结束，
 * 从而顺带卡住无关的调用；这个函数保留下来作为规则的显式说明与测试基准。
 *
 * 两个容易写错的地方，都在测试里留了用例：
 *   - 不能按「第 n 次访问 = 第 n 阶段」分轮：`[a, a, b]` 会把 b 排到第二个 a 之后。
 *   - 阶段必须在每条调用之后立刻结算，否则相邻的不同路径会被塞进同一阶段。
 */
export function planPhases(calls) {
  const nextSlot = new Map();
  const phases = [];
  for (let index = 0; index < calls.length; index += 1) {
    const key = pathOf(calls[index].args);
    if (key === null) {
      // 无路径的调用没有冲突面：单独成一级，既不拖住别人，也不被别人拖住
      phases.push([index]);
      continue;
    }
    const slot = nextSlot.get(key) ?? 0;
    (phases[slot] ??= []).push(index);
    nextSlot.set(key, slot + 1);
    // 结算尾部空阶段：立即新建下一级，让后面的独立调用有机会与本次并行
    if (slot >= phases.length) phases.push([]);
  }
  while (phases.length > 0 && phases[phases.length - 1].length === 0) phases.pop();
  return phases;
}

/** 解析模型给出的参数；失败时直接产出可读的拒绝结果，不抛错 */
export function prepareCall(call) {
  const name = call.function?.name;
  try {
    if (typeof call.function?.arguments !== 'string') {
      throw new Error('工具参数必须是 JSON 字符串');
    }
    const args = JSON.parse(call.function.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('工具参数必须是 JSON 对象');
    }
    return { name, args };
  } catch (err) {
    return {
      name,
      args: null,
      rejected: { status: 'rejected', code: 'invalid_arguments', truncated: false,
        content: `工具 "${name}" 参数不合法: ${err?.message ?? err}` },
    };
  }
}

/** 真正执行一条调用；这里不碰 messages，也不写 checkpoint、不发事件 */
async function executeCall({ call, prepared, registry, signal, now }) {
  if (signal?.aborted) return { skipped: true };
  const startedAt = now();
  if (prepared.rejected) {
    return { result: prepared.rejected, durationMs: 0 };
  }
  const result = typeof registry.invokeResult === 'function'
    ? await registry.invokeResult(prepared.name, prepared.args, { signal })
    : { status: 'success', truncated: false,
      content: await registry.invoke(prepared.name, prepared.args, { signal }) };
  return { result, durationMs: now() - startedAt };
}

/**
 * 跑完一轮的全部调用。
 *
 * 并发规则用「按路径的串行链」表达，而不是先划分阶段再并行：
 *   - 每条调用都立刻启动，互不等待 —— 这是并发收益的来源；
 *   - 只有「同一个路径」上，后一条会先 await 前一条的完成 —— 这是冲突保护。
 * 一条链只影响同一个路径，不会像阶段划分那样顺带卡住无关的调用。
 *
 * @returns {Promise<{concurrent: boolean, skipped: boolean}>}
 */
export async function runToolBatch({ calls, registry, messages, signal, turn, save, emit, now = Date.now }) {
  const prepared = calls.map(prepareCall);
  const concurrent = calls.length > 1;

  // key → 该路径上「最后一条调用的执行 promise」；不同路径互不相干
  const chains = new Map();
  const settled = await Promise.all(calls.map((call, index) => {
    const key = pathOf(prepared[index].args);
    const previous = key === null ? Promise.resolve() : (chains.get(key) ?? Promise.resolve());
    const run = previous
      .catch(() => {})
      .then(() => executeCall({ call, prepared: prepared[index], registry, signal, now }));
    if (key !== null) chains.set(key, run.then(() => {}, () => {}));
    return run.then((outcome) => ({ index, ...outcome }));
  }));

  // 追加、记录、发事件都按模型给出的调用顺序做，和串行版本完全一致
  const ordered = [...settled].sort((left, right) => left.index - right.index);
  let skipped = false;
  for (const entry of ordered) {
    const call = calls[entry.index];
    if (entry.skipped) {
      skipped = true;
      messages.push({ role: 'tool', tool_call_id: call.id,
        content: '本次运行已取消，此工具调用未执行。' });
      continue;
    }
    await save('tool_running', call.id);
    messages.push({ role: 'tool', tool_call_id: call.id, content: entry.result.content });
    await save('tool_batch');
    emit({
      type: 'tool', turn, callId: call.id, name: prepared[entry.index].name,
      status: entry.result.status, truncated: entry.result.truncated,
      outcome: entry.result.code ?? entry.result.status, durationMs: entry.durationMs,
    });
  }
  return {
    concurrent,
    skipped,
    // 调用元数据只含定位信息，不含参数或结果内容；运行层用它把「压缩省略的调用」
    // 映射回具体文件，并判断之后是否又读了同一个文件。
    calls: ordered
      .filter((entry) => !entry.skipped)
      .map((entry) => ({
        callId: calls[entry.index].id,
        name: prepared[entry.index].name,
        path: typeof prepared[entry.index].args?.filePath === 'string'
          ? prepared[entry.index].args.filePath
          : null,
        status: entry.result.status,
      })),
  };
}
