#!/usr/bin/env node
import dotenv from 'dotenv';
import { createOpenAICompatibleModel } from './model/openaiCompatible.js';
import { evalCases, selectEvalCases } from './evals/cases.js';
import { runEvalSuite } from './evals/runEvalSuite.js';
import { writeEvalReport } from './evals/report.js';
import { inspectDocker } from './tools/dockerCommand.js';
import { config } from './config.js';

dotenv.config({ quiet: true });

function usage() {
  return [
    '用法: node src/eval.js [--case <id>] [--repeat <次数>] [--docker] [--keep-workspaces] [--list]',
    '--docker 让命令在一次性容器内执行（只挂载工作区、根只读、无网络），需要 Docker 与 AGENT_DOCKER_IMAGE。',
    '不指定 --case 时运行全部固定测评；可以重复传入 --case。每次运行自动保存 JSON 报告。',
    `可用测评: ${evalCases.map((testCase) => testCase.id).join(', ')}`,
  ].join('\n');
}

function positiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function parseArgs(args) {
  const caseIds = [];
  let keepWorkspaces = false;
  let sandbox = false;
  let repeat = 1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--list') return { list: true };
    if (arg === '--keep-workspaces') keepWorkspaces = true;
    else if (arg === '--docker' || arg === '--sandbox') sandbox = true;
    else if (arg === '--repeat') {
      const raw = args[++index];
      repeat = Number(raw);
      if (!Number.isSafeInteger(repeat) || repeat <= 0 || repeat > 20) {
        throw new Error('--repeat 必须是 1 到 20 的整数');
      }
    }
    else if (arg === '--case') {
      const id = args[++index];
      if (!id) throw new Error('--case 需要测评 ID');
      caseIds.push(id);
    } else if (arg.startsWith('--')) {
      throw new Error(`未知选项: ${arg}`);
    } else {
      throw new Error(`意外参数: ${arg}`);
    }
  }
  return { caseIds, keepWorkspaces, repeat, sandbox };
}

function printSuite(suite, runNumber) {
  for (const result of suite.results) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} [第 ${runNumber} 轮] ${result.id} — ${result.title}`);
    console.log(`  Agent: ${result.status}，${result.turns} 轮，${result.durationMs}ms`);
    const tools = Object.entries(result.toolCounts ?? {})
      .map(([name, count]) => `${name}×${count}`)
      .join(', ');
    console.log(`  工具: ${tools || '(无)'}`);
    if (result.compression?.compactionCount > 0) {
      const rate = result.compression.rereadRate;
      console.log(`  压缩: ${result.compression.compactionCount} 次，省略 ${result.compression.omittedFiles} 个文件，`
        + `重读 ${result.compression.rereadFiles} 个（${rate === null ? '不适用' : `${(rate * 100).toFixed(0)}%`}）`);
    }
    for (const check of result.checks) {
      console.log(`  ${check.passed ? '✓' : '✗'} ${check.name}: ${check.detail}`);
    }
    if (result.workspaceRoot) console.log(`  工作区: ${result.workspaceRoot}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (options.list) {
    for (const testCase of evalCases) console.log(`${testCase.id}\t${testCase.title}`);
    return;
  }

  const cases = selectEvalCases(options.caseIds);
  const modelName = process.env.MODEL_NAME ?? process.env.OPENAI_MODEL;
  let sandbox = null;
  if (options.sandbox) {
    // 沙箱模式下「命令进容器」是硬要求：拿不到 Docker 就不要声称有隔离
    const report = await inspectDocker({ dockerBinary: config.dockerBinary, image: config.dockerImage });
    if (!report.ok) throw new Error(report.reason);
    sandbox = {
      image: config.dockerImage,
      memory: config.dockerMemory,
      cpus: config.dockerCpus,
      pidsLimit: config.dockerPidsLimit,
      user: config.dockerUser,
      dockerBinary: config.dockerBinary,
    };
    console.error(`沙箱: ${report.image}（Docker ${report.serverVersion}），网络关闭，仅挂载工作区`);
  }
  const model = createOpenAICompatibleModel({
    model: modelName,
    apiKey: process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: process.env.MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL,
    maxRetries: config.modelMaxRetries,
  });
  const startedAt = new Date();
  const runs = [];
  for (let runNumber = 1; runNumber <= options.repeat; runNumber += 1) {
    console.error(`开始测评轮次 ${runNumber}/${options.repeat}`);
    const suite = await runEvalSuite({
      cases,
      model,
      keepWorkspace: options.keepWorkspaces,
      maxTurns: positiveInt('AGENT_MAX_TURNS', 12),
      maxDurationMs: positiveInt('AGENT_MAX_DURATION_MS', 120_000),
      maxContextChars: positiveInt('AGENT_MAX_CONTEXT_CHARS', 120_000),
      sandbox,
      onEvent(event) {
        if (event.type === 'model') {
          console.error(`[${event.caseId}] 第 ${event.turn} 轮: ${event.toolCalls ?? 0} 个工具调用`);
        }
        if (event.type === 'tool') console.error(`[${event.caseId}] 工具 ${event.name}: ${event.outcome}`);
        if (event.type === 'batch') {
          console.error(`[${event.caseId}] 第 ${event.turn} 轮: ${event.calls} 个工具调用并发执行`);
        }
      },
    });
    runs.push({ runNumber, ...suite });
    printSuite(suite, runNumber);
  }
  const { path: reportPath, report } = await writeEvalReport({ runs, model: modelName, startedAt });
  console.log(`总结果: ${report.summary.passedCount}/${report.summary.totalCount} 通过（成功率 ${(report.summary.successRate * 100).toFixed(1)}%）`);
  console.log(`报告: ${reportPath}`);
  if (!report.summary.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`测评启动失败: ${err?.message ?? err}`);
  console.error(usage());
  process.exitCode = 1;
});
