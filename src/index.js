#!/usr/bin/env node
import dotenv from 'dotenv';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runAgent } from './agent/runAgent.js';
import { createOpenAICompatibleModel } from './model/openaiCompatible.js';
import { createToolRegistry } from './tools/index.js';

dotenv.config({ quiet: true });

function usage() {
  return [
    '用法: node src/index.js --workspace <目录> [--allow-shell] "任务"',
    '配置: MODEL_NAME、MODEL_API_KEY、可选 MODEL_BASE_URL（也接受 OPENAI_* 对应名称）',
    '限制: AGENT_MAX_TURNS、AGENT_MAX_DURATION_MS、AGENT_MAX_CONTEXT_CHARS',
    'CLI 会读取当前目录的 .env；请将任务工作区放在不含凭据的一次性目录。',
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
  let workspace;
  let allowShell = false;
  const taskParts = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--workspace') {
      workspace = args[++i];
      if (!workspace) throw new Error('--workspace 需要目录参数');
    } else if (arg === '--allow-shell') {
      allowShell = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知选项: ${arg}`);
    } else {
      taskParts.push(arg);
    }
  }
  if (!workspace) throw new Error('必须用 --workspace 指定任务目录');
  if (!taskParts.length) throw new Error('缺少任务内容');
  return { workspace, allowShell, task: taskParts.join(' ') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const workspaceRoot = realpathSync(resolve(options.workspace));
  if (!statSync(workspaceRoot).isDirectory()) throw new Error('工作区不是目录');
  if (existsSync(join(workspaceRoot, '.env'))) {
    throw new Error('工作区根目录含 .env，请使用不含凭据的独立任务目录');
  }

  const model = createOpenAICompatibleModel({
    model: process.env.MODEL_NAME ?? process.env.OPENAI_MODEL,
    apiKey: process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY,
    baseURL: process.env.MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL,
  });
  const registry = createToolRegistry({ workspaceRoot }, { includeExecCommand: options.allowShell });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const result = await runAgent({
    task: options.task,
    model,
    registry,
    maxTurns: positiveInt('AGENT_MAX_TURNS', 12),
    maxDurationMs: positiveInt('AGENT_MAX_DURATION_MS', 120_000),
    maxContextChars: positiveInt('AGENT_MAX_CONTEXT_CHARS', 120_000),
    signal: controller.signal,
    onEvent(event) {
      if (event.type === 'model') console.error(`第 ${event.turn} 轮: 模型返回 ${event.toolCalls} 个工具调用`);
      if (event.type === 'tool') console.error(`工具 ${event.name} (${event.callId}): ${event.outcome}`);
    },
  });

  if (result.answer) console.log(result.answer);
  console.error(`运行状态: ${result.status}；${result.reason}`);
  if (result.status !== 'completed') process.exitCode = 1;
}

main().catch((err) => {
  console.error(`启动失败: ${err?.message ?? err}`);
  console.error(usage());
  process.exitCode = 1;
});
