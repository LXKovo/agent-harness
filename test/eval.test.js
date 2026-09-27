import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { evalCases, selectEvalCases } from '../src/evals/cases.js';
import { runEvalSuite } from '../src/evals/runEvalSuite.js';

const call = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

function response(toolCalls, content = null) {
  return {
    message: { role: 'assistant', content, tool_calls: toolCalls },
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  };
}

function createPassingFakeModel() {
  return {
    async complete({ messages }) {
      const task = messages.find((message) => message.role === 'user').content;
      const toolMessages = messages.filter((message) => message.role === 'tool');

      if (task.includes('转换为大写')) {
        if (toolMessages.length === 0) {
          return response([call('read-input', 'read_file', { filePath: 'input.txt' })]);
        }
        if (toolMessages.length === 1) {
          assert.match(toolMessages[0].content, /red\nblue/);
          return response([call('write-result', 'write_file', {
            filePath: 'result.txt', content: 'RED\nBLUE',
          })]);
        }
        return response([], '转换完成');
      }

      if (toolMessages.length === 0) {
        return response([call('write-result', 'write_file', { filePath: 'result.txt', content: 'hello' })]);
      }
      if (toolMessages.length === 1) {
        return response([call('read-result', 'read_file', { filePath: 'result.txt' })]);
      }
      return response([], '创建完成');
    },
  };
}

test('固定测评在独立临时工作区运行并自动检查结果', async () => {
  const suite = await runEvalSuite({ cases: evalCases, model: createPassingFakeModel() });
  assert.equal(suite.passed, true);
  assert.equal(suite.passedCount, 2);
  assert.equal(suite.totalCount, 2);
  assert.ok(suite.results.every((result) => result.workspaceRoot === null));
  assert.ok(suite.results.every((result) => result.checks.every((check) => check.passed)));
});

test('测评失败由文件检查器决定，不采信模型的完成声明', async () => {
  const model = { complete: async () => response([], '我已经完成') };
  const suite = await runEvalSuite({ cases: [evalCases[0]], model });
  assert.equal(suite.passed, false);
  assert.equal(suite.results[0].status, 'completed');
  assert.equal(suite.results[0].checks[0].passed, false);
});

test('可选择单个测评，保留工作区供人工检查', async () => {
  const selected = selectEvalCases(['create-exact-file']);
  const suite = await runEvalSuite({
    cases: selected,
    model: createPassingFakeModel(),
    keepWorkspace: true,
  });
  const workspaceRoot = suite.results[0].workspaceRoot;
  assert.ok(workspaceRoot);
  await access(workspaceRoot);
  await rm(workspaceRoot, { recursive: true, force: true });
  assert.throws(() => selectEvalCases(['missing-case']), /未知测评/);
});
