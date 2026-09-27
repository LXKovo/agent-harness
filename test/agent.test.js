import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent } from '../src/agent/runAgent.js';
import { createToolRegistry } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createOpenAICompatibleModel } from '../src/model/openaiCompatible.js';

let workspace;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'agent-harness-agent-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const call = (id, name, args) => ({
  id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});
const response = (toolCalls, content = null) => ({
  message: { role: 'assistant', content, tool_calls: toolCalls },
  finishReason: toolCalls.length ? 'tool_calls' : 'stop',
});

test('假模型完成读文件、写文件、验证结果的多轮任务', async () => {
  await writeFile(join(workspace, 'input.txt'), 'hello', 'utf8');
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  registry.register({
    name: 'check_output', description: '检查输出文件内容', schema: z.object({}),
    async invoke() { return await readFile(join(workspace, 'output.txt'), 'utf8'); },
  });
  let index = 0;
  const model = {
    async complete({ messages, tools }) {
      assert.equal(tools.some((tool) => tool.function.name === 'exec_command'), false);
      const steps = [
        response([call('read-1', 'read_file', { filePath: 'input.txt' })]),
        response([call('write-1', 'write_file', { filePath: 'output.txt', content: 'HELLO' })]),
        response([call('check-1', 'check_output', {})]),
        response([], '已创建并检查 output.txt'),
      ];
      if (index > 0) {
        const last = messages.at(-1);
        assert.equal(last.role, 'tool');
        assert.equal(last.tool_call_id, ['read-1', 'write-1', 'check-1'][index - 1]);
        assert.match(last.content, [/hello/, /已创建文件/, /HELLO/][index - 1]);
      }
      return steps[index++];
    },
  };
  const result = await runAgent({ task: '复制并转换内容', model, registry });
  assert.equal(result.status, 'completed');
  assert.equal(result.turns, 4);
  assert.equal(result.answer, '已创建并检查 output.txt');
  assert.equal(await readFile(join(workspace, 'output.txt'), 'utf8'), 'HELLO');
  assert.deepEqual(result.events.filter((event) => event.type === 'tool').map((event) => event.callId),
    ['read-1', 'write-1', 'check-1']);
  assert.deepEqual(result.events.filter((event) => event.type === 'tool').map((event) => event.status),
    ['success', 'success', 'success']);
});

test('无效工具名、参数和 JSON 作为工具结果回传给模型', async () => {
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  const invalidJson = { id: 'bad-json', type: 'function', function: { name: 'read_file', arguments: '{' } };
  const model = {
    async complete({ messages }) {
      if (messages.length === 2) {
        return response([
          call('unknown', 'missing_tool', {}),
          call('bad-schema', 'read_file', {}),
          invalidJson,
        ]);
      }
      assert.deepEqual(messages.slice(-3).map((message) => message.tool_call_id),
        ['unknown', 'bad-schema', 'bad-json']);
      assert.match(messages.at(-3).content, /不存在/);
      assert.match(messages.at(-2).content, /参数不合法/);
      assert.match(messages.at(-1).content, /参数不合法/);
      return response([], '已看到三个错误');
    },
  };
  const result = await runAgent({ task: '检查错误', model, registry });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'tool').map((event) => event.outcome),
    ['unknown_tool', 'invalid_arguments', 'invalid_arguments']);
  assert.deepEqual(result.events.filter((event) => event.type === 'tool').map((event) => event.status),
    ['rejected', 'rejected', 'rejected']);
});

test('Agent 事件记录工具内部错误与截断，模型仍收到文本', async () => {
  await writeFile(join(workspace, 'long.txt'), 'abcdef', 'utf8');
  const registry = createToolRegistry({ workspaceRoot: workspace, maxOutputChars: 3 }, { includeExecCommand: false });
  let calls = 0;
  const model = {
    async complete({ messages }) {
      if (calls++ === 0) return response([
        call('missing', 'read_file', { filePath: 'missing.txt' }),
        call('partial', 'read_file', { filePath: 'long.txt' }),
      ]);
      assert.match(messages.at(-2).content, /读取文件失败/);
      assert.match(messages.at(-1).content, /已截断/);
      return response([], '完成');
    },
  };
  const result = await runAgent({ task: '读取文件', model, registry });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.events.filter((event) => event.type === 'tool')
    .map(({ status, truncated }) => [status, truncated]), [['error', false], ['truncated', true]]);
});

test('注册表将工具异常标为错误，同时保留可读错误', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'broken', description: '失败工具', schema: z.object({}),
    async invoke() { throw new Error('磁盘不可用'); },
  });
  const result = await registry.invokeResult('broken', {});
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'tool_exception');
  assert.match(result.content, /磁盘不可用/);
});

test('轮数、上下文、协议错误与模型错误有明确终止状态', async () => {
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  const endlesslyCalling = { complete: async () => response([call('x', 'list_directory', {})]) };
  assert.equal((await runAgent({ task: '持续调用', model: endlesslyCalling, registry, maxTurns: 1 })).status,
    'max_turns');
  assert.equal((await runAgent({ task: '任务', model: endlesslyCalling, registry, maxContextChars: 1 })).status,
    'context_limit');
  assert.equal((await runAgent({ task: '任务', model: { complete: async () => response([], null) }, registry })).status,
    'protocol_error');
  assert.equal((await runAgent({ task: '任务', model: { complete: async () => { throw new Error('网络错误'); } }, registry })).reason,
    '网络错误');
});

test('模型请求收到总耗时取消信号', async () => {
  const registry = new ToolRegistry();
  const model = {
    complete({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('已取消')), { once: true });
      });
    },
  };
  const result = await runAgent({ task: '等待', model, registry, maxDurationMs: 15 });
  assert.equal(result.status, 'timeout');
});

test('OpenAI 兼容客户端传递消息、工具和取消信号，并拒绝截断响应', async () => {
  const controller = new AbortController();
  const requests = [];
  const client = { chat: { completions: { async create(body, options) {
    requests.push({ body, options });
    return { choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage: { total_tokens: 5 } };
  } } } };
  const model = createOpenAICompatibleModel({ model: 'demo', client });
  const result = await model.complete({ messages: [{ role: 'user', content: '你好' }], tools: [], signal: controller.signal });
  assert.equal(result.message.content, '完成');
  assert.equal(requests[0].body.model, 'demo');
  assert.equal(requests[0].options.signal, controller.signal);
  client.chat.completions.create = async () => ({ choices: [{ message: { content: '不完整' }, finish_reason: 'length' }] });
  await assert.rejects(model.complete({ messages: [], tools: [] }), /输出长度上限/);
});
