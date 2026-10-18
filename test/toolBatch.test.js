import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { runAgent } from '../src/agent/runAgent.js';
import { pathOf, planPhases, runToolBatch } from '../src/agent/toolBatch.js';
import { ToolRegistry } from '../src/tools/registry.js';

const call = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const response = (toolCalls, content = null) => ({
  message: { role: 'assistant', content, tool_calls: toolCalls },
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
});

/** 计数信号量式的屏障：所有参与者都到达后一起放行 */
function createBarrier(size) {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    async wait() {
      arrived += 1;
      if (arrived >= size) release();
      await gate;
      return arrived;
    },
  };
}

function registryWith(handlers, schema = z.object({}).passthrough()) {
  const registry = new ToolRegistry();
  for (const [name, invoke] of Object.entries(handlers)) {
    registry.register({ name, description: name, schema,
      async invoke(args, context) { return invoke(args, context); } });
  }
  return registry;
}

test('参数路径与阶段划分', () => {
  assert.equal(pathOf({ filePath: 'a.txt' }), 'filePath:a.txt');
  assert.equal(pathOf({ cwd: 'src' }), 'cwd:src');
  assert.equal(pathOf({ path: 'x' }), 'path:x');
  assert.equal(pathOf({ command: 'ls' }), null, '不带路径的调用视为可并发');
  assert.equal(pathOf('不是对象'), null);

  // 规则：每条调用放进「它自己那个路径」的下一个可用阶段。
  // same.txt 三次分别落到阶段 0、1、2；那条无路径的调用没有冲突面，填进阶段 1 与第二次并行。
  const phases = planPhases([
    { args: { filePath: 'same.txt' } },
    { args: { command: 'ls' } },
    { args: { filePath: 'same.txt' } },
    { args: { filePath: 'same.txt' } },
  ]);
  assert.deepEqual(phases, [[0], [1, 2], [3]]);
  // 互不相关的路径并行，同路径串行
  assert.deepEqual(planPhases([
    { args: { filePath: 'a' } },
    { args: { filePath: 'a' } },
    { args: { filePath: 'b' } },
  ]), [[0, 2], [1]], 'b 不该排在第二个 a 之后');
  assert.deepEqual(planPhases([{ args: { filePath: 'a' } }, { args: { filePath: 'b' } }]), [[0, 1]]);
});

test('独立调用真的并发，不是排队', async () => {
  const barrier = createBarrier(3);
  const registry = registryWith({
    read_a: () => barrier.wait(),
    read_b: () => barrier.wait(),
    read_c: () => barrier.wait(),
  });
  let turns = 0;
  const result = await runAgent({
    task: '并发读取',
    registry,
    model: { complete: async () => {
      turns += 1;
      if (turns > 1) return response([], '完成');
      return response([
        call('1', 'read_a', {}), call('2', 'read_b', {}), call('3', 'read_c', {}),
      ]);
    } },
    maxDurationMs: 5000,
  });
  // 三个调用若串行执行，第一个会在屏障上等到超时
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'tool').map((event) => event.callId),
    ['1', '2', '3']);
  const batch = result.events.find((event) => event.type === 'batch');
  assert.deepEqual({ calls: batch.calls, mode: batch.mode }, { calls: 3, mode: 'concurrent' });
});

test('同一路径的调用串行，避免最后一次写入吃掉前一次', async () => {
  const registry = registryWith({});
  const spans = new Map();
  for (const name of ['same_a', 'same_b', 'other']) {
    registry.register({
      name, description: name, schema: z.object({}).passthrough(),
      async invoke() {
        spans.set(name, { start: Date.now() });
        await new Promise((resolve) => setTimeout(resolve, 30));
        spans.set(name, { ...spans.get(name), end: Date.now() });
        return 'ok';
      },
    });
  }
  let turns = 0;
  const result = await runAgent({
    task: '两次改同一个文件',
    registry,
    model: { complete: async () => {
      turns += 1;
      if (turns > 1) return response([], '完成');
      // 参数里带上 filePath，阶段划分才会把前两条排到同一条串行队列上
      return response([
        call('1', 'same_a', { filePath: 'same.txt' }),
        call('2', 'same_b', { filePath: 'same.txt' }),
        call('3', 'other', { filePath: 'other.txt' }),
      ]);
    } },
    maxDurationMs: 5000,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'tool').map((event) => event.callId),
    ['1', '2', '3'], '结果顺序仍按模型给出的调用顺序');

  const [a, b, other] = ['same_a', 'same_b', 'other'].map((name) => spans.get(name));
  // 同一路径：后一个开始时间不早于前一个结束时间
  assert.ok(b.start >= a.end, `同一路径必须串行: a=${a.start}-${a.end} b=${b.start}-${b.end}`);
  // 不同路径：与第一组并发，而不是排在它之后
  assert.ok(other.start < a.end, `不同路径应并发: a=${a.start}-${a.end} other=${other.start}-${other.end}`);
});

test('一条调用参数不合法不影响同轮其他调用', async () => {
  const registry = registryWith({ touch: async () => 'touched' });
  let turns = 0;
  const result = await runAgent({
    task: '一条坏一条好',
    registry,
    model: { complete: async () => {
      turns += 1;
      if (turns > 1) return response([], '完成');
      return response([
        { id: 'bad', type: 'function', function: { name: 'touch', arguments: '{' } },
        call('good', 'touch', {}),
      ]);
    } },
    maxDurationMs: 5000,
  });
  assert.equal(result.status, 'completed');
  const tools = result.events.filter((event) => event.type === 'tool');
  assert.deepEqual(tools.map((event) => [event.callId, event.status]),
    [['bad', 'rejected'], ['good', 'success']]);
});

test('取消信号会传给并发中的每个工具，未开始的调用标为未执行', async () => {
  const controller = new AbortController();
  const registry = registryWith({
    slow: async (_args, { signal } = {}) => {
      await new Promise((resolve) => { signal?.addEventListener('abort', resolve, { once: true }); });
      return '被取消';
    },
  });
  let turns = 0;
  const result = await runAgent({
    task: '取消并发调用',
    registry,
    model: { complete: async () => {
      turns += 1;
      if (turns > 1) return response([], '完成');
      setTimeout(() => controller.abort(), 10);
      return response([call('1', 'slow', {}), call('2', 'slow', {})]);
    } },
    signal: controller.signal,
    maxDurationMs: 1000,
  });
  assert.equal(result.status, 'aborted');
  assert.equal(result.state.messages.filter((message) => message.role === 'tool').length, 2);
});

test('并发执行仍按模型给出的顺序回填结果', async () => {
  const finished = [];
  const registry = registryWith({
    slow: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished.push('slow');
      return 'slow-result';
    },
    fast: async () => {
      finished.push('fast');
      return 'fast-result';
    },
  });
  let turns = 0;
  const result = await runAgent({
    task: '顺序无关',
    registry,
    model: { complete: async () => {
      turns += 1;
      if (turns > 1) return response([], '完成');
      // 慢的先发出，但会后完成
      return response([call('1', 'slow', {}), call('2', 'fast', {})]);
    } },
    maxDurationMs: 5000,
  });
  assert.deepEqual(finished, ['fast', 'slow'], '快的先完成，说明确实并发');
  const toolIds = result.state.messages.filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id);
  assert.deepEqual(toolIds, ['1', '2'], '消息顺序必须与模型给出的调用顺序一致');
});

test('工具批次在没有 registry 并发能力时也能单独运行', async () => {
  const registry = registryWith({ touch: async () => 'ok' });
  const calls = [call('x', 'touch', {}), call('y', 'touch', {})];
  const messages = [{ role: 'assistant', content: null, tool_calls: calls }];
  const events = [];
  const phases = [];
  const outcome = await runToolBatch({
    calls,
    registry,
    messages,
    turn: 1,
    signal: undefined,
    save: async (phase, pending) => { phases.push(`${phase}:${pending ?? '-'}`); },
    emit: (event) => events.push(event),
  });
  assert.equal(outcome.concurrent, true);
  assert.equal(outcome.skipped, false);
  assert.deepEqual(phases, ['tool_running:x', 'tool_batch:-', 'tool_running:y', 'tool_batch:-']);
  assert.deepEqual(messages.filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id), ['x', 'y']);
  assert.deepEqual(events.map((event) => event.callId), ['x', 'y']);
});
