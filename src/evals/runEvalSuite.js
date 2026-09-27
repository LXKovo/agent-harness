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

export async function runEvalCase({
  testCase,
  model,
  keepWorkspace = false,
  maxTurns = 12,
  maxDurationMs = 120_000,
  maxContextChars = 120_000,
  onEvent,
}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), `agent-harness-eval-${testCase.id}-`));
  const startedAt = Date.now();
  let agentResult = null;
  let checks = [];
  let error = null;

  try {
    await testCase.setup({ workspaceRoot });
    const registry = createToolRegistry({ workspaceRoot }, { includeExecCommand: false });
    agentResult = await runAgent({
      task: testCase.task,
      model,
      registry,
      maxTurns,
      maxDurationMs,
      maxContextChars,
      onEvent: (event) => onEvent?.({ caseId: testCase.id, ...event }),
    });
    checks = await testCase.check({ workspaceRoot, agentResult });
  } catch (err) {
    error = err?.message ?? String(err);
    checks.push({ name: '测评执行完成', passed: false, detail: error });
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
