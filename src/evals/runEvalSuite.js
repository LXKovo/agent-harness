import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { runAgent } from '../agent/runAgent.js';
import { createToolRegistry } from '../tools/index.js';

function verifyTemporaryWorkspace(workspaceRoot) {
  const parent = resolve(dirname(workspaceRoot));
  if (parent !== resolve(tmpdir()) || !basename(workspaceRoot).startsWith('agent-harness-eval-')) {
    throw new Error(`拒绝清理非测评临时目录: ${workspaceRoot}`);
  }
}

/** 检查详情会进入控制台与 JSON 报告；夹具可能很大，必须限长，否则报告会被文件内容淹没 */
const MAX_DETAIL_CHARS = 200;

function limitDetail(detail) {
  const text = typeof detail === 'string' ? detail : String(detail ?? '');
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}…（详情共 ${text.length} 字符）`
    : text;
}

export async function runEvalCase({
  testCase,
  model,
  keepWorkspace = false,
  maxTurns = 12,
  maxDurationMs = 120_000,
  maxContextChars = 120_000,
  sandbox = null,
  onEvent,
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `agent-harness-eval-${testCase.id}-`));
  const startedAt = Date.now();
  let agentResult = null;
  let checks = [];
  let error = null;

  try {
    await testCase.setup({ workspaceRoot });
    // 沙箱模式下命令一律进容器；进程内后端仍只对显式声明 allowShell 的任务开放。
    // 声明 requiresSandbox 的任务在没有沙箱时直接判失败，避免「工具不在」被误读成模型能力问题。
    if (testCase.requiresSandbox && !sandbox) {
      throw new Error('这项测评需要沙箱：请用 --docker 运行（或设置 AGENT_DOCKER_IMAGE 指向本地镜像）');
    }
    const registry = createToolRegistry(
      { workspaceRoot },
      sandbox
        ? { includeExecCommand: false, sandbox }
        : { includeExecCommand: testCase.allowShell === true },
    );
    agentResult = await runAgent({
      task: testCase.task,
      model,
      registry,
      // 用例可以声明更紧或更宽的轮数预算：不同任务需要的轮数不同，
      // 用全局上限去卡「读取 24 个模块」这类任务，只会把轮数变成噪音
      maxTurns: testCase.maxTurns ?? maxTurns,
      maxDurationMs,
      maxContextChars,
      onEvent: (event) => onEvent?.({ caseId: testCase.id, ...event }),
    });
    checks = (await testCase.check({ workspaceRoot, agentResult }))
      .map((check) => ({ ...check, detail: limitDetail(check.detail) }));
  } catch (err) {
    error = err?.message ?? String(err);
    // 错误详情同样限长
    checks.push({ name: '测评执行完成', passed: false, detail: limitDetail(error) });
  } finally {
    if (!keepWorkspace) {
      verifyTemporaryWorkspace(workspaceRoot);
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }

  const passed = agentResult?.status === 'completed'
    && checks.length > 0
    && checks.every((check) => check.passed);
  return {
    id: testCase.id,
    title: testCase.title,
    passed,
    status: agentResult?.status ?? 'eval_error',
    reason: agentResult?.reason ?? error,
    turns: agentResult?.turns ?? 0,
    durationMs: Date.now() - startedAt,
    checks,
    events: agentResult?.events ?? [],
    workspaceRoot: keepWorkspace ? workspaceRoot : null,
  };
}

export async function runEvalSuite({ cases, model, ...options }) {
  const results = [];
  for (const testCase of cases) {
    results.push(await runEvalCase({ testCase, model, ...options }));
  }
  return {
    passed: results.every((result) => result.passed),
    passedCount: results.filter((result) => result.passed).length,
    totalCount: results.length,
    results,
  };
}
