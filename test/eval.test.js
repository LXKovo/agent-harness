import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evalCases, selectEvalCases } from '../src/evals/cases.js';
import { runEvalSuite } from '../src/evals/runEvalSuite.js';
import { writeEvalReport } from '../src/evals/report.js';

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

      if (task.includes('node --test')) {
        if (toolMessages.length === 0) {
          return response([
            call('read-source', 'read_file', { filePath: 'src/add.js' }),
            call('read-test', 'read_file', { filePath: 'test/add.test.js' }),
          ]);
        }
        if (toolMessages.length === 2) {
          return response([call('fix-source', 'write_file', {
            filePath: 'src/add.js',
            content: 'export function add(left, right) {\n  return left + right;\n}\n',
            overwrite: true,
          })]);
        }
        if (toolMessages.length === 3) {
          return response([call('run-tests', 'exec_command', { command: 'node --test' })]);
        }
        assert.match(toolMessages.at(-1).content, /命令执行成功/);
        return response([], '修复完成，测试通过');
      }

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
  assert.equal(suite.passedCount, 3);
  assert.equal(suite.totalCount, 3);
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

test('测评报告保存重复运行的汇总和诊断事件', async () => {
  const reportDir = await mkdtemp(join(tmpdir(), 'agent-harness-report-'));
  try {
    const suite = await runEvalSuite({
      cases: [evalCases[0]],
      model: createPassingFakeModel(),
    });
    const runs = [
      { runNumber: 1, ...suite },
      { runNumber: 2, ...suite },
    ];
    const { path, report } = await writeEvalReport({
      runs,
      model: 'fake-model',
      startedAt: new Date('2026-09-27T00:00:00.000Z'),
      reportDir,
    });
    assert.equal(report.summary.passedCount, 2);
    assert.equal(report.summary.totalCount, 2);
    assert.equal(report.summary.successRate, 1);
    assert.equal(report.runs[0].results[0].events.some((event) => event.type === 'tool'), true);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).summary, report.summary);
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});
