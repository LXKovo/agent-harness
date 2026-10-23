/**
 * 上下文预算与压缩
 *
 * 背景：`AGENT_MAX_CONTEXT_CHARS` 首版只是一个硬闸门 —— 一超预算就终止整次运行，
 * 于是「读了一个大文件」会直接毁掉这一轮任务，模型没有机会补救。
 * 这里把闸门改成两级：达到软阈值先压缩历史，仍然超出硬阈值才终止。
 *
 * 三条硬约束（压缩不能破坏 Chat Completions 的协议结构）：
 *   1. system 消息和原始任务必须始终保留 —— 丢了它们，模型不知道自己该干什么。
 *   2. 带 tool_calls 的 assistant 消息必须和它的每条 tool 消息同生共死，
 *      否则服务端会因为「工具调用没有结果」直接报错。
 *   3. 最近若干轮的保护窗口不压缩；模型正在依据这些结果决定下一步。
 *
 * 压缩分级（逐级叠加，省够了就停）：
 *   L1 用工具自己声明的 compact 处理器，把长工具结果截断到 maxToolResultChars
 *   L2 仍超预算时把上限收严到 maxToolResultCharsStrict（默认为上一级的 1/6）
 *   L3 把保护窗口之前的工具结果整体换成引用（原始调用参数仍在 assistant 消息里）
 *   L4 丢弃中间整轮对话，并留下明确的「已省略」标记
 *   L5/L6 应急截断：连保护窗口内的结果也截断，仅在窗口本身就让上下文超过硬预算时使用
 *
 * 为什么要分 L1 / L2 两级截断：一次就截到很短的阈值会丢掉模型正在用的细节。
 * 先按宽松上限压缩，只有不够时才继续加严，压缩强度与上下文压力成正比。
 *
 * 为什么 L1/L2 要跳过保护窗口：工具结果产生后，模型要到下一轮才看得到；
 * 如果这一轮就先把它截到 1200 字符，模型永远看不到尾部 —— 保护窗口承诺的
 * 「模型正在依据这些结果决定下一步」就成了空话。L5/L6 是唯一的例外：
 * 窗口本身超过硬预算时，只能截短，否则整次运行会被硬闸门终止。
 */

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** L3 丢弃整轮后插入的标记前缀，用于粗略计数已发生过的丢弃 */
const DROP_MARKER = '[已省略较早的';

/** L3 把旧工具结果整体换成引用后的标记；L1/L2 的截断文案必须与它不同，否则会被误判为已引用 */
const REFERENCE_MARKER = '[较早的工具结果已压缩';

/** L1/L2 截断长结果的标记；标记里带上本次使用的上限，后面才能判断是否已按更严的上限截过 */
const TRUNCATION_MARKER = '[内容过长，已截断到';

/** 已经按哪个上限截断过；返回 null 表示没截过 */
function truncatedAt(content) {
  if (typeof content !== 'string') return null;
  const matched = content.match(/\[内容过长，已截断到 (\d+) 字符/);
  return matched ? Number(matched[1]) : null;
}

/** 每条消息的固定协议开销（role、tool_call_id 等字段） */
const MESSAGE_OVERHEAD_CHARS = 32;

export const DEFAULT_SOFT_CONTEXT_RATIO = 0.7;
export const DEFAULT_KEEP_RECENT_TURNS = 2;

/**
 * 粗略 token 估算 —— 只用于报告，不参与预算判定
 *
 * 预算判定使用字符数，因为它不需要引入 tokenizer 依赖也不需要联网。
 * 这个估算只为让人能对照服务端返回的 usage 判断偏差量级。
 */
export function estimateTokens(value) {
  if (value === null || value === undefined) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  let tokens = 0;
  let asciiRun = 0;
  for (const char of text) {
    if (CJK.test(char)) {
      // 中日韩字符大约一字一 token
      if (asciiRun) { tokens += Math.ceil(asciiRun / 4); asciiRun = 0; }
      tokens += 1;
    } else {
      asciiRun += 1;
    }
  }
  return tokens + Math.ceil(asciiRun / 4);
}

/** 与 runAgent 的硬闸门同口径的序列化长度，外加逐条消息的固定开销 */
export function estimateContextChars(messages, tools = []) {
  return JSON.stringify(messages).length
    + JSON.stringify(tools).length
    + messages.length * MESSAGE_OVERHEAD_CHARS;
}

/** 由硬预算推导软阈值；显式传入 softChars 时优先 */
export function resolveSoftChars(maxContextChars, softChars, softRatio = DEFAULT_SOFT_CONTEXT_RATIO) {
  if (Number.isSafeInteger(softChars) && softChars > 0) return softChars;
  return Math.max(1, Math.floor(maxContextChars * softRatio));
}

/** 从消息里粗算已丢弃的轮数，使压缩次数在会话恢复后继续累计 */
export function countDroppedTurns(messages) {
  return messages.reduce((total, message) => (
    typeof message?.content === 'string' && message.content.startsWith(DROP_MARKER)
      // 必须与 L4 写入的文案同格式，否则恢复会话时会重复丢弃
      ? total + (Number(message.content.match(/(\d+) 轮对话已省略/)?.[1]) || 0)
      : total
  ), 0);
}

/** 判断一条消息是否是「带 tool_calls 的 assistant」或「它的 tool 结果」 */
function isToolExchange(message) {
  return message?.role === 'tool' || (message.role === 'assistant' && Array.isArray(message.tool_calls));
}

/**
 * 找到保护窗口的起点：最近 keepTurns 次「交换」的第一条消息。
 *
 * 索引 0（system）和索引 1（原始任务）永不压缩，所以边界最小是 2。
 * 一次交换 = 一条工具结果（连同发起它的 assistant），
 * 或一条不带 tool_calls 的 assistant 消息，或一条 user 消息。
 *
 * 工具循环里模型经常连续多轮只发工具调用，所以不能按 user 消息数轮次。
 * 边界必须落在一组 assistant + tool 的最前面：从中间截断会拆散协议配对。
 */
function protectionStartIndex(messages, keepTurns) {
  const floor = 2;
  const endings = [];
  for (let index = messages.length - 1; index >= floor && endings.length < keepTurns; index -= 1) {
    const message = messages[index];
    if (message.role === 'tool' || (message.role === 'assistant' && !isToolExchange(message))
      || (message.role === 'user' && !isToolExchange(message))) {
      endings.push(index);
    }
  }
  if (endings.length === 0) return floor;
  // endings 是从末尾往前收集的，最后一个是最早的结尾，先以它为起点
  let start = endings[endings.length - 1];
  for (const ending of endings) {
    let candidate = ending;
    while (candidate > floor && messages[candidate].role === 'tool') candidate -= 1;
    // 再往前一条 user 消息属于新一轮，也要保护
    if (candidate > floor && messages[candidate - 1]?.role === 'user') candidate -= 1;
    if (candidate < start) start = candidate;
  }
  return start;
}

/**
 * 把一条工具结果压到 maxChars 以内。
 * 先用工具自己声明的 compact 处理器（它最懂自己结果的哪些部分可以丢），
 * 处理器没提供或压得不够狠时，再按 maxChars 硬截并打标记。
 */
function shrinkToolContent(message, registry, maxChars) {
  const raw = typeof message.content === 'string' ? message.content : '';
  if (raw.length <= maxChars) return raw;
  let text = raw;
  if (registry && typeof registry.getProcessor === 'function') {
    try {
      const processed = registry.getProcessor(message.name).compact(raw);
      if (typeof processed === 'string' && processed.length > 0) text = processed;
    } catch {
      // 处理器是外部声明的可选契约，坏处理器不能让整个运行崩掉
      text = raw;
    }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n${TRUNCATION_MARKER} ${maxChars} 字符，需要完整内容请重新读取]`;
}

/**
 * 按需压缩历史消息。返回新数组，不修改入参，也不产生任何副作用。
 *
 * @param {object} options
 * @param {object[]} options.messages 当前完整消息
 * @param {object[]} [options.tools] 工具定义（计入预算）
 * @param {object} [options.registry] 提供 getProcessor()，用于 L1
 * @param {number} options.maxContextChars 硬预算
 * @param {number} [options.softChars] 软阈值，默认按 softRatio 推导
 * @param {number} [options.maxToolResultChars] L1 截断长度
 * @param {number} [options.maxToolResultCharsStrict] L2 更严的截断长度
 * @param {number} [options.keepRecentTurns] 保护窗口轮数
 * @param {number} [options.maxDroppedTurns] L3 单次最多丢弃的轮数
 * @returns {{messages: object[], compacted: boolean, actions: Array<{level: number, count: number, savedChars: number}>, estimate: object, omittedCallIds: string[]}}
 *
 * `omittedCallIds` 只包含这次压缩新「整条省略」的工具结果（L3 换引用、L4 丢弃），
 * 不含 L1/L2 截断 —— 截断后模型仍能看到一部分内容，不算完全失去来源。
 * 运行层据此知道哪些文件的读取结果已经不在上下文里，从而统计模型是否重读。
 */
export function compactMessages({
  messages,
  tools = [],
  registry = null,
  maxContextChars,
  softChars,
  softRatio = DEFAULT_SOFT_CONTEXT_RATIO,
  maxToolResultChars = 1200,
  maxToolResultCharsStrict = Math.max(1, Math.floor(maxToolResultChars / 6)),
  keepRecentTurns = DEFAULT_KEEP_RECENT_TURNS,
  maxDroppedTurns = 4,
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages 必须是非空数组');
  }
  if (!Number.isSafeInteger(maxContextChars) || maxContextChars <= 0) {
    throw new RangeError('maxContextChars 必须是正整数');
  }

  const limit = resolveSoftChars(maxContextChars, softChars, softRatio);
  const current = messages;
  const before = estimateContextChars(current, tools);
  const result = {
    messages: current,
    compacted: false,
    actions: [],
    omittedCallIds: [],
    estimate: {
      chars: before,
      limit,
      hardLimit: maxContextChars,
      tokens: estimateTokens(current),
      messages: current.length,
      ratio: before / maxContextChars,
      rough: true,
    },
  };
  if (before <= limit) return result;

  const protectedFrom = protectionStartIndex(current, keepRecentTurns);
  let working = current;

  /** 逐级压缩：满足预算即停，并记录每级实际省下的字符 */
  const applyLevel = (level, transform) => {
    const sizeBefore = estimateContextChars(working, tools);
    const next = transform(working);
    const sizeAfter = estimateContextChars(next, tools);
    if (next === working || sizeAfter >= sizeBefore) return false;
    working = next;
    result.actions.push({ level, count: 1, savedChars: sizeBefore - sizeAfter });
    return true;
  };

  /** L1/L2 共用的截断：把超过 maxChars 的工具结果压到上限以内 */
  const truncateToolResults = (maxChars, includeProtected = false) => (input) => {
    let changed = false;
    const next = input.map((message, index) => {
      if (message.role !== 'tool' || typeof message.content !== 'string') return message;
      // 保护窗口内的结果不动：模型还没看到它，这一轮就截掉等于没读到。
      // 只有应急级别（L5/L6）才允许 includeProtected。
      if (!includeProtected && index >= protectedFrom) return message;
      if (message.content.length <= maxChars) return message;
      // 只有「按更严的上限再截一次」才有意义：已经截到更短的就不再动它
      const already = truncatedAt(message.content);
      if (already !== null && already <= maxChars) return message;
      changed = true;
      return { ...message, content: shrinkToolContent(message, registry, maxChars) };
    });
    return changed ? next : input;
  };

  // L1：长工具结果按工具自己的 compact 语义截断
  if (Number.isSafeInteger(maxToolResultChars) && maxToolResultChars > 0) {
    applyLevel(1, truncateToolResults(maxToolResultChars));
  }

  // L2：仍超预算才把上限收严，压缩强度随上下文压力上升
  if (estimateContextChars(working, tools) > limit
    && Number.isSafeInteger(maxToolResultCharsStrict) && maxToolResultCharsStrict > 0
    && maxToolResultCharsStrict < maxToolResultChars) {
    applyLevel(2, truncateToolResults(maxToolResultCharsStrict));
  }

  // L3：保护窗口之前的工具结果只留引用，调用参数仍在 assistant 消息里
  if (estimateContextChars(working, tools) > limit) {
    applyLevel(3, (input) => {
      let changed = false;
      const next = input.map((message, index) => {
        if (index >= protectedFrom || message.role !== 'tool') return message;
        if (message.content.includes(REFERENCE_MARKER)) return message;
        changed = true;
        return { ...message, content: `${REFERENCE_MARKER}，调用参数见上一条 assistant 消息]` };
      });
      return changed ? next : input;
    });
  }

  // L4：丢弃保护窗口之前的整段历史。起点就是保护边界，
  // 这样被丢掉的永远是完整的「assistant + 它的 tool 结果」组，不会拆散协议配对。
  if (estimateContextChars(working, tools) > limit) {
    applyLevel(4, (input) => {
      const boundary = protectionStartIndex(input, keepRecentTurns);
      const alreadyDropped = countDroppedTurns(input);
      const budget = Math.max(0, maxDroppedTurns - alreadyDropped);
      if (budget === 0 || boundary <= 2) return input;
      const dropped = input.slice(2, boundary).filter((message) => !(
        typeof message.content === 'string' && message.content.startsWith(DROP_MARKER)
      ));
      if (dropped.length === 0) return input;
      // 一轮 = 一条 user 消息，或一组 assistant（含工具调用）+ 它的 tool 结果。
      // 这次丢弃会连带删掉上一条省略标记，所以必须把它的计数加回来，
      // 否则「已丢弃轮数」会在每次压缩时被抹掉，恢复会话时就无法续算。
      const carriedOver = input.slice(2, boundary).reduce((total, message) => (
        typeof message.content === 'string' && message.content.startsWith(DROP_MARKER)
          ? total + (Number(message.content.match(/(\d+) 轮对话已省略/)?.[1]) || 0)
          : total
      ), 0);
      const turns = Math.min(budget, Math.max(1, dropped.filter((message) => (
        message.role === 'user' || (message.role === 'assistant' && !Array.isArray(message.tool_calls))
      )).length)) + carriedOver;
      return [
        input[0],
        input[1],
        { role: 'user', content: `${DROP_MARKER} ${turns} 轮对话已省略；需要时可重新读取文件或重新运行命令确认当前状态]` },
        ...input.slice(boundary),
      ];
    });
  }

  // L5/L6：应急。前四级都不碰保护窗口，所以「窗口本身就让上下文超过硬预算」时它们
  // 无能为力。与其让 runAgent 以 context_limit 终止整次任务，不如让模型看到被截短的结果：
  // 截断只损失细节，终止损失的是整轮任务。先按 L1 的上限，仍超硬预算再收到 L2 的上限。
  if (estimateContextChars(working, tools) > maxContextChars) {
    applyLevel(5, truncateToolResults(maxToolResultChars, true));
  }
  if (estimateContextChars(working, tools) > maxContextChars) {
    applyLevel(6, truncateToolResults(maxToolResultCharsStrict, true));
  }

  // 收集这次压缩「整条省略」的工具调用：
  //   - L3 把结果换成引用，消息还在，但内容已经不可用；
  //   - L4 把 assistant + tool 整组丢掉，消息直接消失。
  // 已经在上一次压缩里省略过的调用不计入，否则每次压缩都会把同一批 ID 再报一遍。
  // L1/L2 的截断结果仍保留部分内容，不算省略。
  if (working !== current) {
    const alreadyReferenced = new Set(current
      .filter((message) => message.role === 'tool'
        && typeof message.content === 'string' && message.content.startsWith(REFERENCE_MARKER))
      .map((message) => message.tool_call_id));
    const present = new Set(working
      .filter((message) => message.role === 'tool')
      .map((message) => message.tool_call_id));
    for (const message of current) {
      if (message.role !== 'tool' || alreadyReferenced.has(message.tool_call_id)) continue;
      if (!present.has(message.tool_call_id)) result.omittedCallIds.push(message.tool_call_id);
    }
    for (const message of working) {
      if (message.role !== 'tool' || alreadyReferenced.has(message.tool_call_id)) continue;
      if (typeof message.content === 'string' && message.content.startsWith(REFERENCE_MARKER)) {
        result.omittedCallIds.push(message.tool_call_id);
      }
    }
  }

  result.compacted = working !== current;
  result.messages = working;
  result.estimate = {
    ...result.estimate,
    chars: estimateContextChars(working, tools),
    tokens: estimateTokens(working),
    messages: working.length,
    ratio: estimateContextChars(working, tools) / maxContextChars,
    droppedTurns: countDroppedTurns(working),
  };
  return result;
}
