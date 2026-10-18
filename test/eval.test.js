import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

async function listFiles(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const collected = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) collected.push(...await listFiles(root, relativePath));
    else collected.push(relativePath);
  }
  return collected;
}

function createPassingFakeModel() {
  return {
    async complete({ messages }) {
      const task = messages.find((message) => message.role === 'user').content;
      const toolMessages = messages.filter((message) => message.role === 'tool');

      if (task.includes('featureEnabled: false')) {
        if (toolMessages.length === 0) {
          return response([call('search-setting', 'search_files', { query: 'featureEnabled: false' })]);
        }
        if (toolMessages.length === 1) {
          assert.match(toolMessages[0].content, /src\/settings\.js/);
          return response([call('read-setting', 'read_file', { filePath: 'src/settings.js' })]);
        }
        if (toolMessages.length === 2) {
          return response([call('patch-setting', 'apply_patch', {
            filePath: 'src/settings.js',
            edits: [{ oldText: 'featureEnabled: false', newText: 'featureEnabled: true' }],
          })]);
        }
        if (toolMessages.length === 3) {
          return response([call('verify-setting', 'read_file', { filePath: 'src/settings.js' })]);
        }
        assert.match(toolMessages.at(-1).content, /featureEnabled: true/);
        return response([], '配置已完成局部修改并复查');
      }

      if (task.includes('SERVICE_TIMEOUT_MS')) {
        if (toolMessages.length === 0) {
          return response([
            call('read-aurora', 'read_file', { filePath: 'src/aurora.js' }),
            call('read-vega', 'read_file', { filePath: 'src/vega.js' }),
          ]);
        }
        if (toolMessages.length === 2) {
          assert.ok(toolMessages.every((message) => message.content.length > 0));
          return response([call('patch-config', 'apply_patch', {
            filePath: 'src/config.js',
            edits: [{
              oldText: 'export const SERVICE_TIMEOUT_MS = 30_000;',
              newText: 'export const SERVICE_TIMEOUT_MS = 5_000;',
            }],
          })]);
        }
        if (toolMessages.length === 3) {
          return response([call('verify-config', 'read_file', { filePath: 'src/config.js' })]);
        }
        assert.match(toolMessages.at(-1).content, /SERVICE_TIMEOUT_MS = 5_000/);
        return response([], '已修改并确认：export const SERVICE_TIMEOUT_MS = 5_000;');
      }

      if (task.includes('left-pad')) {
        // 沙箱任务的假模型分支：先跑测试拿到失败，再修，再验证网络不可用
        if (toolMessages.length === 0) {
          return response([call('run-tests', 'exec_command', { command: 'node --test' })]);
        }
        if (toolMessages.length === 1) {
          return response([call('fix-source', 'write_file', {
            filePath: 'src/multiply.js',
            content: 'export function multiply(left, right) {\n  return left * right;\n}\n',
            overwrite: true,
          })]);
        }
        if (toolMessages.length === 2) {
          return response([call('probe-network', 'exec_command', { command: 'npm run probe' })]);
        }
        return response([], 'npm run probe 失败：沙箱内没有网络，DNS 解析不可用。');
      }

      if (task.includes('EU_WEST_3_ENDPOINT')) {
        if (toolMessages.length === 0) {
          return response([call('search-endpoint', 'search_files', { query: 'EU_WEST_3_ENDPOINT' })]);
        }
        if (toolMessages.length === 1) {
          assert.match(toolMessages[0].content, /edge-3\.js/);
          return response([call('read-endpoint', 'read_file', { filePath: 'src/services/edge/edge-3.js' })]);
        }
        assert.match(toolMessages.at(-1).content, /EU_WEST_3_ENDPOINT/);
        return response([], '定义在 src/services/edge/edge-3.js，值是 https://api.eu-west-3.harness.example/v2');
      }

      if (task.includes('M-6600')) {
        if (toolMessages.length === 0) {
          return response([call('search-token', 'search_files', { query: 'M-6600' })]);
        }
        assert.match(toolMessages[0].content, /config\/release\.js/);
        return response([], '发布令牌是 W-4471');
      }

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
  // 沙箱任务在无沙箱时会明确失败，所以这里只跑不需要沙箱的那些
  const cases = evalCases.filter((testCase) => !testCase.requiresSandbox);
  const suite = await runEvalSuite({ cases, model: createPassingFakeModel() });
  assert.equal(suite.passed, true);
  assert.equal(suite.passedCount, cases.length);
  assert.equal(suite.totalCount, cases.length);
  assert.ok(evalCases.length >= 8);
  assert.ok(evalCases.some((testCase) => testCase.requiresSandbox), '应有需要沙箱的任务');
  assert.ok(suite.results.every((result) => result.workspaceRoot === null));
  assert.ok(suite.results.every((result) => result.checks.every((check) => check.passed)));
});

test('需要沙箱的测评在没有沙箱时明确失败，而不是静默跳过', async () => {
  const sandboxCase = evalCases.find((testCase) => testCase.requiresSandbox);
  const suite = await runEvalSuite({ cases: [sandboxCase], model: createPassingFakeModel() });
  assert.equal(suite.passed, false);
  assert.equal(suite.results[0].status, 'eval_error');
  assert.match(suite.results[0].checks[0].detail, /需要沙箱/);
});

test('大规模夹具的合成源码保持可搜索且体积真实', async () => {
  const source = evalCases.find((testCase) => testCase.id === 'edit-large-file');
  const token = evalCases.find((testCase) => testCase.id === 'gather-token-across-files');
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-fixture-'));
  const tokenRoot = await mkdtemp(join(tmpdir(), 'agent-harness-fixture-token-'));
  try {
    await source.setup({ workspaceRoot: root });
    const aurora = await readFile(join(root, 'src', 'aurora.js'), 'utf8');
    const config = await readFile(join(root, 'src', 'config.js'), 'utf8');
    // 单个文件必须远大于 read_file 的输出上限，否则测不到「先搜索再读取」的路径
    assert.ok(aurora.length > 60_000, `aurora.js 只有 ${aurora.length} 字符`);
    // 目标行必须唯一，否则按字面量搜索会有歧义
    assert.equal(config.split('SERVICE_TIMEOUT_MS = 30_000').length - 1, 1);
    assert.equal(aurora.includes('SERVICE_TIMEOUT_MS'), false);
    for (const line of aurora.split('\n')) assert.ok(line.length <= 120, `过长行: ${line.length}`);

    await token.setup({ workspaceRoot: tokenRoot });
    const release = await readFile(join(tokenRoot, 'config', 'release.js'), 'utf8');
    assert.equal(release.split('W-4471').length - 1, 1);
    assert.equal(release.includes('M-6600'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(tokenRoot, { recursive: true, force: true });
  }
});

test('大面积探索夹具越过上下文预算，目标常量全库唯一', async () => {
  const exploration = evalCases.find((testCase) => testCase.id === 'explore-large-repo');
  assert.ok(exploration, '应注册 explore-large-repo');
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-fixture-explore-'));
  try {
    await exploration.setup({ workspaceRoot: root });
    const files = await listFiles(root);
    assert.equal(files.length, 61, '应为 60 个模块加一个 README');
    let totalChars = 0;
    let needleHits = 0;
    let endpointHits = 0;
    for (const path of files) {
      const content = await readFile(join(root, path), 'utf8');
      totalChars += content.length;
      needleHits += content.split('EU_WEST_3_ENDPOINT').length - 1;
      endpointHits += content.split('_ENDPOINT').length - 1;
    }
    // 通读全部文件必然越过 120000 字符的默认硬预算，只能靠检索定位
    assert.ok(totalChars > 130_000, `夹具合计只有 ${totalChars} 字符`);
    // 精确搜索唯一命中；宽泛搜索会撞上 8 个诱饵
    assert.equal(needleHits, 1);
    assert.equal(endpointHits, 9);
    assert.ok(files.includes('src/services/edge/edge-3.js'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
