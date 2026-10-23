import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent, createInitialAgentState } from '../src/agent/runAgent.js';
import {
  compactMessages,
  countDroppedTurns,
  estimateContextChars,
  estimateTokens,
  resolveSoftChars,
} from '../src/agent/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createToolRegistry } from '../src/tools/index.js';

let workspace;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-harness-context-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const TRUNCATION = '[内容过长，已截断到';
const REFERENCE = '[较早的工具结果已压缩';
const DROPPED = '[已省略较早的';

const call = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const response = (toolCalls, content = null) => ({
  message: { role: 'assistant', content, tool_calls: toolCalls },
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
});

/**
 * 协议不变式：每条 assistant 的 tool_calls 都必须有对应 tool 结果，反之亦然。
 * 压缩最容易犯的错就是拆散这一对，所以每个用例都验一遍。
 */
function assertToolPairingIntact(messages) {
  const requested = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const item of message.tool_calls) requested.add(item.id);
    }
  }
  const answered = new Set(messages.filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id));
  assert.deepEqual([...answered].sort(), [...requested].sort(),
    'tool 结果集合必须与 assistant 声明的 tool_calls 完全一致');
  for (const message of messages) {
    if (message.role === 'tool') assert.ok(requested.has(message.tool_call_id));
  }
}

function stubRegistry(payloadLength = 8000, { compact = (result) => result } = {}) {
  const registry = new ToolRegistry();
  const payload = 'x'.repeat(payloadLength);
  registry.register({
    name: 'fake_read', description: '返回固定长度的长文本', schema: z.object({}),
    async invoke() { return payload; },
    async invokeResult() { return { status: 'success', content: payload, truncated: false }; },
  }, { compact, summarize: (result) => result.slice(0, 20) });
  return registry;
}

/** 组装一段真实形状的历史：每轮一个 assistant 工具调用 + 一个长 tool 结果 */
function history(turns, payloadLength) {
  const messages = [
    { role: 'system', content: '你是助手。' },
    { role: 'user', content: '长期任务' },
  ];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [call(`c${index}`, 'fake_read', {})] });
    // name 必须带上：注册表按工具名路由 compact 处理器，真实 Agent 也总带它
    messages.push({ role: 'tool', tool_call_id: `c${index}`, name: 'fake_read',
      content: 'y'.repeat(payloadLength) });
  }
  return messages;
}

function toolIds(messages) {
  return messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
}

/** 与运行时同口径的选项：软阈值按比例推导，压紧时显式给一个小值 */
function compactionOptions(registry, maxContextChars, overrides = {}) {
  return {
    registry, maxContextChars, softRatio: 0.5,
    maxToolResultChars: 200, keepRecentTurns: 1, maxDroppedTurns: 6,
    ...overrides,
  };
}

test('token 估算区分中日韩字符与 ASCII，且只用于报告', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('中文字符'), 4);
  assert.ok(estimateTokens('中文abcd') < estimateTokens('中文中文中文'));
  assert.equal(estimateTokens(null), 0);
});

test('上下文长度含工具定义与逐条消息开销，软阈值由比例推导且可覆盖', () => {
  const messages = [{ role: 'user', content: 'hi' }];
  const tools = [{ type: 'function', function: { name: 't' } }];
  assert.ok(estimateContextChars(messages, tools) > JSON.stringify(messages).length);
  assert.equal(resolveSoftChars(1000, undefined, 0.7), 700);
  assert.equal(resolveSoftChars(1000, 250, 0.7), 250);
  assert.equal(resolveSoftChars(1, undefined, 0.7), 1);
  assert.throws(() => compactMessages({ messages: [], maxContextChars: 10 }), /非空数组/);
  assert.throws(() => compactMessages({ messages, maxContextChars: 0 }), /正整数/);
});

test('未达软阈值时不改动消息，也不留下标记', () => {
  const messages = history(2, 100);
  const result = compactMessages({ messages, maxContextChars: 100_000 });
  assert.equal(result.compacted, false);
  assert.deepEqual(result.messages, messages);
  assert.deepEqual(result.actions, []);
  assert.equal(result.estimate.chars, estimateContextChars(messages, []));
  assert.equal(result.estimate.hardLimit, 100_000);
});

test('预算宽裕时不做任何压缩', () => {
  const registry = stubRegistry();
  const messages = history(6, 6000);
  const result = compactMessages({ messages, ...compactionOptions(registry, 120_000) });
  assert.equal(result.compacted, false);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(toolIds(result.messages), toolIds(messages));
});

test('L1 先用工具自己的 compact 处理器，再按上限兜底截断', () => {
  const registry = stubRegistry(5000, { compact: (result) => result.slice(0, 500) });
  const messages = history(3, 5000);
  // 软阈值只允许第一级触发；最后一个结果在保护窗口内，必须保持原样
  const result = compactMessages({ messages, ...compactionOptions(registry, 8000, { softChars: 7000 }) });
  assert.deepEqual(result.actions.map((action) => action.level), [1]);
  assertToolPairingIntact(result.messages);
  assert.equal(toolIds(result.messages).length, 3);
  const contents = result.messages.filter((message) => message.role === 'tool')
    .map((message) => message.content);
  const outsideWindow = contents.slice(0, 2);
  // 处理器给出 500，上限是 200，所以最终按 200 截断，标记必须写实际长度
  assert.ok(outsideWindow.every((content) => content.length === 231));
  assert.ok(outsideWindow.every((content) => content.includes('已截断到 200 字符')),
    '标记必须写实际生效的上限，不能沿用处理器的返回长度');
  assert.equal(contents.at(-1).length, 5000, '保护窗口内刚读到的结果不能被截断');
  assert.deepEqual(result.omittedCallIds, [], 'L1/L2 只是截断，工具结果并未整条省略');
});

test('处理器已经压到上限以内时不再加截断标记', () => {
  // 处理器恰好压到上限（200），此时不应再追加截断标记
  const registry = stubRegistry(5000, { compact: (result) => result.slice(0, 200) });
  const messages = history(3, 5000);
  const result = compactMessages({ messages, ...compactionOptions(registry, 8000, { softChars: 7000 }) });
  assert.deepEqual(result.actions.map((action) => action.level), [1]);
  const contents = result.messages.filter((message) => message.role === 'tool')
    .map((message) => message.content);
  assert.ok(contents.slice(0, 2).every((content) => content.length === 200), '处理器结果应被原样采用');
  assert.ok(contents.slice(0, 2).every((content) => !content.includes(TRUNCATION)), '未截断就不该有标记');
  assert.equal(contents.at(-1).length, 5000);
});

test('L2 会按更严的上限重新截断 L1 的结果', () => {
  const messages = history(20, 800);
  // 软阈值卡在第二级之后：第三、四级来不及触发
  const result = compactMessages({ messages, ...compactionOptions(null, 100_000, { softChars: 8000 }) });
  assert.deepEqual(result.actions.map((action) => action.level), [1, 2]);
  assert.ok(result.messages.filter((message) => message.role === 'tool'
    && message.tool_call_id !== 'c19')
    .every((message) => message.content.includes('已截断到 33 字符')),
  '第二级应把上限收严到 maxToolResultChars 的 1/6');
  assert.equal(result.messages.at(-1).content.length, 800, '保护窗口内的结果不参与前两级');
  assertToolPairingIntact(result.messages);
});

test('L3 只把保护窗口之前的工具结果换成引用', () => {
  const messages = history(20, 3000);
  // 第二级之后仍超软阈值，所以第三级会触发；第三级之后降到阈值以内
  const result = compactMessages({ messages, ...compactionOptions(null, 100_000, { softChars: 9300 }) });
  assert.deepEqual(result.actions.map((action) => action.level), [1, 2, 3]);
  const references = result.messages.filter((message) => message.role === 'tool'
    && message.content.startsWith(REFERENCE));
  assert.deepEqual(references.map((message) => message.tool_call_id),
    Array.from({ length: 19 }, (_, index) => `c${index}`));
  assert.equal(toolIds(result.messages).length, 20, '被换成引用的工具结果仍留在原位');
  assert.equal(result.messages.at(-1).content.length, 3000, '最近一轮的工具结果必须原样保留');
  assert.deepEqual(result.omittedCallIds, references.map((message) => message.tool_call_id),
    '换成引用的工具调用必须全部报为已省略');
  assertToolPairingIntact(result.messages);
});

test('保护窗口按 keepRecentTurns 保留最近 N 次交换，且窗口内结果不被截断', () => {
  const messages = history(6, 6000);
  const one = compactMessages({ messages, ...compactionOptions(null, 100_000, { softChars: 100 }) });
  assert.deepEqual(toolIds(one.messages), ['c5'], 'keepRecentTurns=1 只保留最近一次交换');
  assert.equal(one.messages.at(-1).content.length, 6000, '保护窗口内的结果不能被截断');
  assertToolPairingIntact(one.messages);

  const two = compactMessages({
    messages, ...compactionOptions(null, 100_000, { softChars: 100, keepRecentTurns: 2 }),
  });
  assert.deepEqual(toolIds(two.messages), ['c4', 'c5']);

  const three = compactMessages({
    messages, ...compactionOptions(null, 100_000, { softChars: 100, keepRecentTurns: 3 }),
  });
  assert.deepEqual(toolIds(three.messages), ['c3', 'c4', 'c5']);
  assert.ok(two.estimate.chars > one.estimate.chars, '保护更多交换时占用应更大');
  assert.ok(three.estimate.chars > two.estimate.chars);
});

test('保护窗口本身超过硬预算时应急截断，而不是直接终止', () => {
  const messages = history(1, 6000);
  const result = compactMessages({ messages, ...compactionOptions(null, 3000, { softChars: 100 }) });
  // 唯一的交换就在保护窗口里，前四级都动不了它，只能走第五级应急截断
  assert.deepEqual(result.actions.map((action) => action.level), [5]);
  assert.ok(result.estimate.chars <= 3000, '应急截断后必须回到硬预算以内');
  assert.ok(result.messages.at(-1).content.includes(TRUNCATION));
  assertToolPairingIntact(result.messages);
});

test('逐级加严：截断不够时先收严，再换引用，最后丢弃整段历史', () => {
  const registry = stubRegistry();
  const messages = history(6, 6000);
  // 硬预算放大，避免窗口本身触发第五级应急截断：本用例只验证前四级
  const result = compactMessages({ messages, ...compactionOptions(registry, 100_000, { softChars: 100 }) });
  assert.deepEqual(result.actions.map((action) => action.level), [1, 2, 3, 4]);
  assert.ok(result.actions.every((action) => action.savedChars > 0));
  assertToolPairingIntact(result.messages);
  assert.ok(result.messages.some((message) => typeof message.content === 'string'
    && message.content.startsWith(DROPPED)), '应留下省略标记');
  assert.equal(countDroppedTurns(result.messages), 1, '丢掉的轮数必须能从标记读回');
  assert.equal(result.messages[0].role, 'system', 'system 消息不能被压缩掉');
  assert.equal(result.messages[1].content, '长期任务', '原始任务不能被压缩掉');
  assert.equal(result.messages.at(-2).role, 'assistant', '最近一次交换必须完整保留');
  assert.equal(result.messages.at(-1).role, 'tool');
  assert.ok(result.estimate.chars < estimateContextChars(messages, []));
});

test('压缩是幂等的：再次运行不会继续丢消息', () => {
  const registry = stubRegistry();
  const messages = history(6, 6000);
  const options = compactionOptions(registry, 5000, { softChars: 100 });
  const first = compactMessages({ messages, ...options });
  assert.equal(first.compacted, true);
  const second = compactMessages({ messages: first.messages, ...options });
  assert.equal(second.compacted, false);
  assert.deepEqual(second.messages, first.messages);
  assert.deepEqual(second.actions, []);
});

test('没有可丢弃的整轮时只做应急截断，不产生省略标记', () => {
  const messages = history(2, 6000);
  // 两次交换都在保护窗口内，前四级动不了它们，只能走第五级应急截断
  const result = compactMessages({
    messages, ...compactionOptions(null, 3000, { softChars: 100, keepRecentTurns: 2 }),
  });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.actions.map((action) => action.level), [5]);
  assert.ok(result.estimate.chars <= 3000);
  assertToolPairingIntact(result.messages);
  assert.equal(result.messages.some((message) => typeof message.content === 'string'
    && message.content.startsWith(DROPPED)), false);
});

test('工具处理器抛错时退回原始文本，不让压缩打断运行', () => {
  const registry = stubRegistry(4000, { compact: () => { throw new Error('坏处理器'); } });
  const messages = history(3, 4000);
  const result = compactMessages({ messages, ...compactionOptions(registry, 4000, { softChars: 100 }) });
  assert.equal(result.compacted, true);
  assertToolPairingIntact(result.messages);
});

test('运行中达到软阈值会压缩历史并继续，不终止任务', async () => {
  await writeFile(join(workspace, 'a.txt'), 'payload', 'utf8');
  const payloadLength = 1200;
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  registry.register({
    name: 'bulk_read', description: '返回固定长度的长文本', schema: z.object({}),
    async invoke() { return 'z'.repeat(payloadLength); },
    async invokeResult() { return { status: 'success', content: 'z'.repeat(payloadLength), truncated: false }; },
  });
  const totalTurns = 8;
  let index = 0;
  const observed = [];
  const model = {
    async complete({ messages }) {
      observed.push(structuredClone(messages));
      if (index < totalTurns) return response([call(`read-${index++}`, 'bulk_read', {})]);
      return response([], '任务完成');
    },
  };

  const auto = await runAgent({
    task: '连续读取多个文件', model, registry, maxTurns: totalTurns + 2,
  });
  assert.equal(auto.status, 'completed');
  assert.deepEqual(auto.events.filter((event) => event.type === 'context'), [],
    '默认预算下这些消息不该触发压缩');

  index = 0;
  observed.length = 0;
  const sized = await runAgent({
    task: '连续读取多个文件', model, registry, maxTurns: totalTurns + 2,
    maxContextChars: 12_000, softContextRatio: 0.5, keepRecentTurns: 1,
  });
  assert.equal(sized.status, 'completed', '压缩之后任务应能继续跑完');
  const contextEvents = sized.events.filter((event) => event.type === 'context');
  assert.ok(contextEvents.length >= 1, '应记录上下文压缩事件');
  const last = contextEvents.at(-1);
  assert.equal(last.action, 'compacted');
  assert.ok(last.savedChars > 0, '压缩必须真的省下字符');
  assert.ok(last.levels.some((level) => [1, 2, 3, 4].includes(level.level)));
  assert.equal(last.softLimit, 6000);
  assert.equal(last.hardLimit, 12_000);
  assert.ok(last.estimatedTokens > 0);

  const finalMessages = observed.at(-1);
  assertToolPairingIntact(finalMessages);
  assert.equal(finalMessages[0].role, 'system');
  assert.equal(finalMessages[1].content, '连续读取多个文件');
  assert.ok(finalMessages.some((message) => message.role === 'tool'), '最近一轮的工具结果必须在场');
  // 压缩把长结果截断，所以最终长度远小于「每条结果原样保留」的量级
  assert.ok(estimateContextChars(finalMessages, []) < totalTurns * payloadLength);
});

test('刚读到的长结果，在模型第一次看到它的那一轮必须完整', async () => {
  // 回归用例：结果产生后模型要到下一轮才看得到。如果这一轮就先把它截到 1200 字符，
  // 模型永远读不到尾部 —— 这正是 24 模块夹具把审计行放在文件末尾时踩到的坑。
  const registry = new ToolRegistry();
  const payload = `${'a'.repeat(5900)}TAIL-TOKEN`;
  registry.register({
    name: 'tail_read', description: '返回带尾部标记的长文本', schema: z.object({}),
    async invoke() { return payload; },
    async invokeResult() { return { status: 'success', content: payload, truncated: false }; },
  });
  let index = 0;
  const observedLast = [];
  const model = {
    async complete({ messages }) {
      const tools = messages.filter((message) => message.role === 'tool');
      if (tools.length) observedLast.push(tools.at(-1).content);
      if (index++ < 3) return response([call(`tail-${index}`, 'tail_read', {})]);
      return response([], '完成');
    },
  };
  const result = await runAgent({
    task: '连续读取大数据文件', model, registry, maxTurns: 6,
    // 每轮读 6KB，软阈值 10000：第三轮起就会压缩，把更早的结果截掉
    maxContextChars: 20_000, softContextRatio: 0.5, keepRecentTurns: 1,
  });
  assert.equal(result.status, 'completed');
  assert.equal(observedLast.length, 3);
  for (const [turn, content] of observedLast.entries()) {
    assert.ok(content.includes('TAIL-TOKEN'),
      `第 ${turn + 1} 次看到的最近结果必须完整，实际长度 ${content.length}`);
    assert.ok(content.length > 5000, `第 ${turn + 1} 次看到的结果被提前截断了`);
  }
  const contextEvents = result.events.filter((event) => event.type === 'context');
  assert.ok(contextEvents.length >= 1, '本用例必须真的触发过压缩');
});

test('多次丢弃时「已省略轮数」累计而不是被覆盖', () => {
  const messages = history(8, 6000);
  const options = compactionOptions(null, 100_000, { softChars: 100 });
  const first = compactMessages({ messages, ...options });
  assert.deepEqual(first.actions.map((action) => action.level), [1, 2, 3, 4]);
  const firstDropped = countDroppedTurns(first.messages);
  assert.ok(firstDropped >= 1);

  // 再追加几轮长历史，触发第二次丢弃
  const grown = [...first.messages];
  for (let index = 0; index < 4; index += 1) {
    grown.push({ role: 'assistant', content: null, tool_calls: [call(`n${index}`, 'fake_read', {})] });
    grown.push({ role: 'tool', tool_call_id: `n${index}`, name: 'fake_read', content: 'y'.repeat(6000) });
  }
  const second = compactMessages({ messages: grown, ...options });
  assert.ok(second.actions.some((action) => action.level === 4), '第二次也应触发丢弃');
  assert.ok(countDroppedTurns(second.messages) >= firstDropped,
    '丢弃计数必须累计，不能被新的标记覆盖');
  assertToolPairingIntact(second.messages);
});

test('从已压缩的 checkpoint 恢复时不会重复丢弃历史', async () => {
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  registry.register({
    name: 'bulk_read', description: '返回固定长度的长文本', schema: z.object({}),
    async invoke() { return 'z'.repeat(4000); },
    async invokeResult() { return { status: 'success', content: 'z'.repeat(4000), truncated: false }; },
  });
  const task = '继续读取';
  // 模拟一个「已经压缩过一轮」的 checkpoint 快照
  const state = createInitialAgentState(task);
  state.messages.push({ role: 'user', content: `${DROPPED} 2 轮对话已省略；需要时可重新读取文件或重新运行命令确认当前状态]` });
  for (let index = 0; index < 4; index += 1) {
    state.messages.push({ role: 'assistant', content: null,
      tool_calls: [call(`c${index}`, 'bulk_read', {})] });
    state.messages.push({ role: 'tool', tool_call_id: `c${index}`, name: 'bulk_read',
      content: 'y'.repeat(4000) });
  }
  let index = 0;
  const observed = [];
  const result = await runAgent({
    task, model: { async complete({ messages }) {
      observed.push(structuredClone(messages));
      if (index++ < 2) return response([call(`more-${index}`, 'bulk_read', {})]);
      return response([], '完成');
    } },
    registry, initialState: state, maxTurns: 6,
    maxContextChars: 5000, softContextRatio: 0.5, keepRecentTurns: 1,
  });
  assert.equal(result.status, 'completed');
  const finalMessages = observed.at(-1);
  assertToolPairingIntact(finalMessages);
  assert.equal(finalMessages.filter((message) => typeof message.content === 'string'
    && message.content.startsWith(DROPPED)).length, 1, '恢复后不应叠加多个省略标记');
  // 恢复后这一轮又会丢弃一批，所以计数只会累加，不会退回 0
  assert.ok(countDroppedTurns(finalMessages) >= 2, '原有的丢弃计数必须被续算');
  assert.equal(finalMessages[0].role, 'system');
  assert.equal(finalMessages[1].content, task);
  const contextEvent = result.events.filter((event) => event.type === 'context').at(-1);
  assert.ok(contextEvent.compactionRounds > 1, '恢复后的压缩轮数应从已有标记继续累计');
});

test('压缩后仍超硬预算时终止为 context_limit，并说明原因', async () => {
  // 工具定义和任务本身就超过硬预算，压缩省不出任何空间
  const registry = new ToolRegistry();
  registry.register({
    name: 'bulk_read', description: 'z'.repeat(4000), schema: z.object({}),
    async invoke() { return 'z'; },
    async invokeResult() { return { status: 'success', content: 'z'.repeat(4000), truncated: false }; },
  });
  const model = { async complete() { return response([call('read-0', 'bulk_read', {})]); } };
  const result = await runAgent({
    task: '连续读取', model, registry, maxTurns: 6, maxContextChars: 120, softContextRatio: 0.5,
  });
  assert.equal(result.status, 'context_limit');
  assert.match(result.reason, /字符预算/);
  assert.ok(result.events.some((event) => event.type === 'stop' && event.status === 'context_limit'));
});

test('压缩省略文件后，模型重读同一文件会被记录', async () => {
  const payload = 'x'.repeat(6000);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    await writeFile(join(workspace, name), payload, 'utf8');
  }
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  let index = 0;
  const model = {
    async complete({ messages }) {
      const step = index++;
      if (step === 0) return response([call('read-a', 'read_file', { filePath: 'a.txt' })]);
      if (step === 1) return response([call('read-b', 'read_file', { filePath: 'b.txt' })]);
      if (step === 2) return response([call('read-c', 'read_file', { filePath: 'c.txt' })]);
      if (step === 3) {
        // 第四轮开始时 a 已在保护窗口之外：可能被换成引用（L3），也可能整组被丢弃（L4）。
        // 两种情况都算「a 的读取结果已不在上下文里」，后续重读应能被识别。
        assert.ok(messages.some((message) => message.role === 'tool'
          && typeof message.content === 'string' && message.content.startsWith(REFERENCE))
        || messages.some((message) => typeof message.content === 'string'
          && message.content.startsWith(DROPPED)),
        'a.txt 的读取结果应已被压缩省略');
        // 故意用 ./ 前缀重读，验证路径归一化
        return response([call('reread-a', 'read_file', { filePath: './a.txt' })]);
      }
      return response([], '完成');
    },
  };
  const result = await runAgent({
    task: '依次读取三个文件并复查', model, registry, maxTurns: 6,
    maxContextChars: 20_000, softContextRatio: 0.4, keepRecentTurns: 2,
  });
  assert.equal(result.status, 'completed');
  const contextEvents = result.events.filter((event) => event.type === 'context'
    && event.action === 'compacted');
  assert.ok(contextEvents.length >= 1, '本用例必须真的触发压缩');
  assert.ok(contextEvents.some((event) => event.omittedFiles.includes('a.txt')),
    '压缩事件应报告被省略的文件路径');
  const reread = result.events.filter((event) => event.type === 'reread');
  assert.deepEqual(reread.map((event) => [event.path, event.first]), [['a.txt', true]]);
  assert.deepEqual(result.compression.omittedPaths, ['a.txt', 'b.txt']);
  assert.deepEqual(result.compression.rereadPaths, ['a.txt']);
  assert.equal(result.compression.omittedResults, 2);
  assert.equal(result.compression.rereadCalls, 1);
  assert.equal(result.compression.rereadRate, 0.5);
  // stop 事件里带同一份汇总，报告不必再从事件流里反推
  const stop = result.events.find((event) => event.type === 'stop');
  assert.deepEqual(stop.compression, result.compression);
});

test('压缩统计随 checkpoint 恢复，重读仍能被识别', async () => {
  await writeFile(join(workspace, 'a.txt'), 'content', 'utf8');
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  const task = '继续检查已压缩过的文件';
  const state = createInitialAgentState(task);
  state.compression = { omittedPaths: ['a.txt'], rereadPaths: [], omittedResults: 1, rereadCalls: 0 };
  state.messages.push({ role: 'assistant', content: null,
    tool_calls: [call('old-read', 'read_file', { filePath: 'a.txt' })] });
  state.messages.push({ role: 'tool', tool_call_id: 'old-read', name: 'read_file',
    content: `${REFERENCE}，调用参数见上一条 assistant 消息]` });
  let index = 0;
  const result = await runAgent({
    task, initialState: state, registry, maxTurns: 4,
    model: { async complete() {
      if (index++ === 0) return response([call('new-read', 'read_file', { filePath: 'a.txt' })]);
      return response([], '已重新读取');
    } },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.compression.omittedPaths, ['a.txt']);
  assert.deepEqual(result.compression.rereadPaths, ['a.txt']);
  assert.equal(result.compression.rereadCalls, 1);
});

test('预算参数非法时立即拒绝，不发起模型请求', async () => {
  const registry = stubRegistry(10);
  let called = 0;
  const model = { async complete() { called += 1; return response([], '完成'); } };
  await assert.rejects(runAgent({ task: '任务', model, registry, softContextRatio: 0 }),
    /softContextRatio/);
  await assert.rejects(runAgent({ task: '任务', model, registry, softContextRatio: 1.5 }),
    /softContextRatio/);
  await assert.rejects(runAgent({ task: '任务', model, registry, keepRecentTurns: 0 }),
    /keepRecentTurns/);
  assert.equal(called, 0);
});
