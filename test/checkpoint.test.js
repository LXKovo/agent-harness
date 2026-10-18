import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, createInitialAgentState } from '../src/agent/runAgent.js';
import { createCheckpointStore } from '../src/agent/checkpointStore.js';
import { createToolRegistry } from '../src/tools/index.js';

test('中断发生在工具写入之后、结果持久化之前时，恢复不重放工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-checkpoint-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = createCheckpointStore(join(root, 'sessions.sqlite'));
  const task = '创建 result.txt';
  const state = createInitialAgentState(task);
  store.create({ id: 'task-1', workspace, task, allowShell: false, state });
  const registry = createToolRegistry({ workspaceRoot: workspace }, { includeExecCommand: false });
  const toolCall = { id: 'write-1', type: 'function', function: {
    name: 'write_file', arguments: JSON.stringify({ filePath: 'result.txt', content: 'hello' }),
  } };

  try {
    await assert.rejects(runAgent({
      task, registry, initialState: state,
      model: { complete: async () => ({ message: { content: null, tool_calls: [toolCall] } }) },
      onCheckpoint(snapshot) {
        if (snapshot.phase === 'tool_batch') throw new Error('模拟进程中断');
        store.save('task-1', snapshot);
      },
    }), /模拟进程中断/);
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'hello');
    assert.equal(store.load('task-1').state.phase, 'tool_running');

    let modelCalls = 0;
    const result = await runAgent({
      task, registry, initialState: store.load('task-1').state,
      model: { async complete({ messages }) {
        modelCalls += 1;
        assert.equal(messages.at(-1).tool_call_id, 'write-1');
        assert.match(messages.at(-1).content, /执行结果未知/);
        return { message: { content: '已检查文件状态', tool_calls: [] } };
      } },
      onCheckpoint: (snapshot) => store.save('task-1', snapshot),
    });
    store.save('task-1', result.state, result.status, result.answer);
    assert.equal(modelCalls, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.turns, 2);
    assert.equal((await readFile(join(workspace, 'result.txt'), 'utf8')), 'hello');
    assert.equal(store.load('task-1').status, 'completed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('并发恢复同一会话时拒绝使用过期的 checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-checkpoint-'));
  const path = join(root, 'sessions.sqlite');
  const first = createCheckpointStore(path);
  const second = createCheckpointStore(path);
  try {
    const state = createInitialAgentState('任务');
    first.create({ id: 'shared', workspace: root, task: '任务', allowShell: false, state });
    second.load('shared');
    first.save('shared', state);
    assert.throws(() => second.save('shared', state), /其他进程修改/);
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('已保存的工具结果在恢复时继续传给模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-checkpoint-'));
  const store = createCheckpointStore(join(root, 'sessions.sqlite'));
  const task = '读取两个文件';
  const calls = ['first', 'second'].map((id) => ({
    id, type: 'function', function: { name: 'list_directory', arguments: '{}' },
  }));
  // 直接构造「一条结果已落库、另一条在飞行中」的快照。
  // 并发执行之后靠崩溃时序去制造这个中间态已经不可靠了，
  // 但恢复语义本身必须继续成立，所以这里显式构造它。
  const state = createInitialAgentState(task);
  state.messages.push({ role: 'assistant', content: null, tool_calls: calls });
  state.messages.push({ role: 'tool', tool_call_id: 'first', content: '第一个结果' });
  state.phase = 'tool_running';
  state.pendingCallId = 'second';
  store.create({ id: 'task-2', workspace: root, task, allowShell: false, state });
  const registry = createToolRegistry({ workspaceRoot: root }, { includeExecCommand: false });
  try {
    const result = await runAgent({
      task, registry, initialState: store.load('task-2').state,
      model: { async complete({ messages }) {
        assert.deepEqual(messages.slice(-2).map((message) => message.tool_call_id), ['first', 'second']);
        assert.equal(messages.at(-2).content, '第一个结果', '已保存的结果必须原样带过去');
        assert.match(messages.at(-1).content, /执行结果未知/);
        return { message: { content: '完成', tool_calls: [] } };
      } },
      onCheckpoint: (snapshot) => store.save('task-2', snapshot),
    });
    assert.equal(result.status, 'completed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('同轮并发执行时每条调用只执行一次，恢复不重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-checkpoint-'));
  const store = createCheckpointStore(join(root, 'sessions.sqlite'));
  const task = '并发读取';
  const state = createInitialAgentState(task);
  const registry = createToolRegistry({ workspaceRoot: root }, { includeExecCommand: false });
  const calls = ['a', 'b'].map((id) => ({
    id, type: 'function', function: { name: 'list_directory', arguments: '{}' },
  }));
  store.create({ id: 'task-3', workspace: root, task, allowShell: false, state });
  try {
    // 每个调用各写一次 tool_running、各写一次 tool_batch：
    // 并发之后 checkpoint 的粒度仍然是「一条调用」，不是「一整轮」。
    const phases = [];
    let turns = 0;
    const first = await runAgent({
      task, registry, initialState: state,
      model: { complete: async ({ messages }) => {
        turns += 1;
        const toolIds = messages.filter((message) => message.role === 'tool')
          .map((message) => message.tool_call_id);
        assert.deepEqual(toolIds, [...new Set(toolIds)], '工具结果不能重复');
        if (turns > 1) return { message: { content: '完成', tool_calls: [] } };
        return { message: { content: null, tool_calls: calls } };
      } },
      onCheckpoint(snapshot) {
        phases.push(`${snapshot.phase}:${snapshot.pendingCallId ?? '-'}`);
        store.save('task-3', snapshot);
      },
    });
    assert.equal(first.status, 'completed');
    // 每条调用各写一次 tool_running 与 tool_batch：checkpoint 粒度仍是「一条调用」。
    // 两条调用无路径、可以并发，所以两次 tool_running 都会先于结果落库。
    assert.deepEqual([...phases].sort(), [
      'ready:-', 'tool_batch:-', 'tool_batch:-', 'tool_running:a', 'tool_running:b',
    ]);
    assert.deepEqual(phases.filter((phase) => phase.startsWith('tool_running')),
      ['tool_running:a', 'tool_running:b']);
    assert.equal(phases.filter((phase) => phase === 'tool_batch:-').length, 2);
    const toolEvents = first.events.filter((event) => event.type === 'tool');
    assert.deepEqual(toolEvents.map((event) => event.callId), ['a', 'b'], '顺序必须与模型给出的一致');
    assert.equal(toolEvents.length, 2, '每条调用只执行一次');

    // 从落库后的状态恢复：不应再执行任何工具，也不应补重复的 tool 消息
    const saved = store.load('task-3').state;
    let completions = 0;
    const resumed = await runAgent({
      task, registry, initialState: saved,
      model: { async complete({ messages }) {
        completions += 1;
        const toolIds = messages.filter((message) => message.role === 'tool')
          .map((message) => message.tool_call_id);
        assert.deepEqual(toolIds, ['a', 'b'], '恢复时不应重放也不应重复补消息');
        return { message: { content: '完成', tool_calls: [] } };
      } },
      onCheckpoint: (snapshot) => store.save('task-3', snapshot),
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(completions, 1);
    assert.equal(resumed.events.filter((event) => event.type === 'tool').length, 0, '恢复后不该再跑工具');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
