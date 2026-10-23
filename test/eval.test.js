import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evalCases, selectEvalCases, sweepAuditFixture, aggregateAuditFixture,
} from '../src/evals/cases.js';
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

/**
 * 假模型的扫读状态：按任务文本区分会话。
 *
 * 每次会话开始时 toolMessages 为空，状态重置 —— 否则同一任务重跑时会把
 * 上一轮的最大值带进来，测试就测不到「本轮读到了什么」。
 */
const sweepSessions = new Map();
const aggregateSessions = new Map();

function sweepState(task, toolMessages) {
  if (toolMessages.length === 0 || !sweepSessions.has(task)) {
    sweepSessions.set(task, { seen: 0, best: null });
  }
  const state = sweepSessions.get(task);
  // 只解析本轮新增的结果：旧结果可能已被上下文压缩截断，这正是要模拟的行为
  for (const message of toolMessages.slice(state.seen)) {
    const filePath = message.content.match(/^文件: (.+)$/m)?.[1];
    const auditLine = message.content.split('\n').find((line) => line.startsWith('// audit: '));
    const weightText = auditLine?.slice(-8) ?? '';
    const weight = /^\d{8}$/.test(weightText) ? Number(weightText) : NaN;
    if (filePath && Number.isFinite(weight) && (!state.best || weight > state.best.weight)) {
      state.best = { filePath, weight };
    }
  }
  state.seen = toolMessages.length;
  return state;
}

function createPassingFakeModel() {
  return {
    async complete({ messages }) {
      const task = messages.find((message) => message.role === 'user').content;
      const toolMessages = messages.filter((message) => message.role === 'tool');

      if (task.includes('TOTAL=')) {
        // 汇总任务：逐批读取 12 个模块，把每条的 weight 记在本地状态里。
        // 压缩可能把旧工具结果换成引用，所以按 call ID 去重，而不是按消息下标。
        if (toolMessages.length === 0) aggregateSessions.delete(task);
        if (!aggregateSessions.has(task)) {
          aggregateSessions.set(task, { requested: 0, weights: new Map(), processed: new Set() });
        }
        const state = aggregateSessions.get(task);
        for (const message of toolMessages) {
          if (state.processed.has(message.tool_call_id)) continue;
          state.processed.add(message.tool_call_id);
          const filePath = message.content.match(/^文件: (.+)$/m)?.[1];
          const auditLine = message.content.split('\n').find((line) => line.startsWith('// audit: '));
          const weightText = auditLine?.slice(-8) ?? '';
          if (filePath && /^\d{8}$/.test(weightText)) state.weights.set(filePath, Number(weightText));
        }
        if (state.requested < aggregateAuditFixture.modules.length) {
          const batch = aggregateAuditFixture.modules.slice(state.requested, state.requested + 4);
          state.requested += batch.length;
          return response(batch.map((filePath, index) => (
            call(`aggregate-${state.requested - batch.length + index}`, 'read_file', { filePath })
          )));
        }
        assert.equal(state.weights.size, aggregateAuditFixture.modules.length, '应读全 12 个模块');
        const [bestPath, bestWeight] = [...state.weights.entries()]
          .sort((left, right) => right[1] - left[1])[0];
        const total = [...state.weights.values()].reduce((sum, weight) => sum + weight, 0);
        return response([], `最大的是 ${bestPath}，weight=${bestWeight}\nTOTAL=${total}`);
      }

      if (task.includes('weight 最大')) {
        const state = sweepState(task, toolMessages);
        if (state.seen < sweepAuditFixture.modules.length) {
          const batch = sweepAuditFixture.modules.slice(state.seen, state.seen + 6);
          return response(batch.map((filePath, index) => (
            call(`sweep-${state.seen + index}`, 'read_file', { filePath })
          )));
        }
        assert.ok(state.best, '假模型应从读取结果里找到权重');
        return response([], `weight 最大的是 ${state.best.filePath}，weight = ${state.best.weight}`);
      }

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

      if (task.includes('src/math.js')) {
        // 跨文件修复：先读三个文件，再分别打两个补丁，最后跑测试
        if (toolMessages.length === 0) {
          return response([
            call('read-math', 'read_file', { filePath: 'src/math.js' }),
            call('read-report', 'read_file', { filePath: 'src/report.js' }),
            call('read-report-test', 'read_file', { filePath: 'test/report.test.js' }),
          ]);
        }
        if (toolMessages.length === 3) {
          return response([
            call('fix-math', 'apply_patch', {
              filePath: 'src/math.js',
              edits: [{ oldText: '  return value + factor;', newText: '  return value * factor;' }],
            }),
            call('fix-report', 'apply_patch', {
              filePath: 'src/report.js',
              edits: [{ oldText: 'scale(value, factor + 1)', newText: 'scale(value, factor)' }],
            }),
          ]);
        }
        if (toolMessages.length === 5) {
          return response([call('run-tests', 'exec_command', { command: 'node --test' })]);
        }
        assert.match(toolMessages.at(-1).content, /命令执行成功/);
        return response([], '修复完成，测试通过');
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
  assert.ok(evalCases.length >= 9);
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

test('通读夹具迫使逐个读取，权重落在检索预览之外', async () => {
  const sweep = evalCases.find((testCase) => testCase.id === 'sweep-audit-weights');
  assert.ok(sweep, '应注册 sweep-audit-weights');
  assert.equal(sweep.maxTurns, 24, '读取 24 个模块的最坏情况是一轮读一个，需要 24 轮预算');
  assert.equal(sweep.maxDurationMs, 240_000, '这类探索任务的耗时安全网应高于全局 120 秒');
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-fixture-sweep-'));
  try {
    await sweep.setup({ workspaceRoot: root });
    const files = await listFiles(root);
    assert.equal(files.length, 25, '应为 24 个模块加一个 README');
    assert.equal(sweepAuditFixture.modules.length, 24);
    assert.deepEqual([...files].sort(), [...sweepAuditFixture.modules, 'README.md'].sort());

    let totalChars = 0;
    const weights = new Map();
    for (const path of files) {
      const content = await readFile(join(root, path), 'utf8');
      totalChars += content.length;
      if (path === 'README.md') continue;
      // 去掉可检索的 `"weight":` 键，命中/未命中不能再用来逐位试探
      assert.ok(!content.includes('"weight":'), `${path} 不应包含可检索的 "weight": 键`);
      const lines = content.split('\n');
      const audits = lines.filter((line) => line.startsWith('// audit: '));
      assert.equal(audits.length, 1, `${path} 应只有一条审计行`);
      const [auditLine] = audits;
      assert.equal(lines[0], auditLine, `${path} 的审计行必须是第一行`);
      // search_files 的预览只回显每行前 300 字符；weight 是整行最后 8 个字符，
      // 必须完全落在 300 之后，否则一次搜索就能拿到权重，夹具失去意义
      const weightText = auditLine.slice(-8);
      assert.match(weightText, /^\d{8}$/, `${path} 的审计行末尾不是 8 位十进制 weight`);
      const weightStart = auditLine.length - 8;
      assert.ok(weightStart > 300, `${path} 的 weight 落在检索预览范围内`);
      // 同时要落在 L1 压缩保留的前 1200 字符内，否则失败可能来自压缩截断而不是读取策略
      assert.ok(weightStart < 1200, `${path} 的 weight 位于 L1 截断之后`);
      assert.ok(auditLine.length < 400, `${path} 审计行有 ${auditLine.length} 字符`);
      // 封条长度逐模块变化，让「按列号定位某一位」也不再可行
      const packed = auditLine.slice('// audit: '.length).split(' ')[1];
      const seal = packed.slice(0, -8);
      assert.match(seal, /^[0-9a-f]{300,360}$/, `${path} 的封条形状不符合预期`);
      assert.match(seal.at(-1), /[a-f]/, `${path} 的封条最后一位应为字母`);
      weights.set(path, Number(weightText));
    }
    assert.equal(weights.size, 24, '每个模块都应有一条带 weight 的审计行');
    // 逐个读取全部模块必然越过 120000 字符的默认硬预算，读取过程会触发压缩
    assert.ok(totalChars > 130_000, `夹具合计只有 ${totalChars} 字符`);
    // 最大值必须唯一，检查器才能只凭回答判定对错
    const sorted = [...weights.entries()].sort((left, right) => right[1] - left[1]);
    assert.equal(sorted[0][0], sweepAuditFixture.maxPath);
    assert.equal(sorted[0][1], sweepAuditFixture.maxWeight);
    assert.ok(sorted[0][1] > sorted[1][1], '最大值必须唯一');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sweep 检查器拒绝数字检索探测 weight', async () => {
  const sweep = evalCases.find((testCase) => testCase.id === 'sweep-audit-weights');
  assert.ok(sweep);
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-fixture-probe-'));
  try {
    await sweep.setup({ workspaceRoot: root });
    const answer = `最大的是 ${sweepAuditFixture.maxPath}，weight=${sweepAuditFixture.maxWeight}`;
    const probeChecks = await sweep.check({
      workspaceRoot: root,
      agentResult: {
        answer,
        state: {
          messages: [{
            role: 'assistant',
            content: null,
            tool_calls: [call('probe', 'search_files', { query: '6421' })],
          }],
        },
      },
    });
    const probe = probeChecks.find((check) => check.name.includes('数字检索'));
    assert.ok(probe, '应包含数字检索检查');
    assert.equal(probe.passed, false, '数字前缀检索应被判为探测');
    assert.match(probe.detail, /6421/);

    const cleanChecks = await sweep.check({
      workspaceRoot: root,
      agentResult: { answer, state: { messages: [] } },
    });
    assert.equal(cleanChecks.find((check) => check.name.includes('数字检索')).passed, true);
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

test('用例可以声明自己的预算，实际生效值会记录在结果里', async () => {
  const model = createPassingFakeModel();
  const custom = {
    ...evalCases[0], maxTurns: 5, maxDurationMs: 30_000, maxContextChars: 40_000,
  };
  const suite = await runEvalSuite({ cases: [custom], model });
  assert.deepEqual(suite.results[0].budget, {
    maxTurns: 5, maxDurationMs: 30_000, maxContextChars: 40_000,
  });

  // 没声明预算的用例回落到全局默认，报告里同样能看出它是在什么上限下失败的
  const plain = await runEvalSuite({ cases: [evalCases[0]], model });
  assert.deepEqual(plain.results[0].budget, {
    maxTurns: 12, maxDurationMs: 120_000, maxContextChars: 120_000,
  });
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
