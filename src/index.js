#!/usr/bin/env node
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { runAgent, createInitialAgentState } from './agent/runAgent.js';
import { createCheckpointStore } from './agent/checkpointStore.js';
import { episodeFromResult, relevantEpisodes, renderEpisodes } from './agent/episodicMemory.js';
import { DEFAULT_KEEP_RECENT_TURNS, DEFAULT_SOFT_CONTEXT_RATIO } from './agent/context.js';
import { createOpenAICompatibleModel } from './model/openaiCompatible.js';
import { createToolRegistry } from './tools/index.js';
import { inspectDocker } from './tools/dockerCommand.js';
import { config } from './config.js';

dotenv.config({ quiet: true });

function usage() {
  return [
    '用法: node src/index.js --workspace <目录> [--docker | --allow-shell] [--session <ID>] [--project <项目 ID>] "任务"',
    '恢复: node src/index.js --resume <ID> [--checkpoint-db <SQLite 文件>]',
    '沙箱: --docker 在一次性容器内执行命令（只挂载工作区、根只读、无网络）；镜像由 AGENT_DOCKER_IMAGE 指定。',
    '      拿不到 Docker 或镜像时直接退出，不会退化成无隔离执行。',
    '情景记忆: 新任务加 --project <项目 ID>，会自动创建会话并检索同项目的历史记录。',
    '会话默认保存在 .agent-harness/checkpoints.sqlite；首次运行和恢复须使用同一数据库。',
    '配置: MODEL_NAME、MODEL_API_KEY、可选 MODEL_BASE_URL（也接受 OPENAI_* 对应名称）',
    '限制: AGENT_MAX_TURNS、AGENT_MAX_DURATION_MS、AGENT_MAX_CONTEXT_CHARS',
    '上下文: 达到 AGENT_MAX_CONTEXT_CHARS 的比例 AGENT_CONTEXT_SOFT_RATIO（默认 0.7）时先压缩历史，',
    '        保护最近 AGENT_KEEP_RECENT_TURNS 次交换（默认 2）；压缩后仍超硬预算才终止。',
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

/** 上下文软阈值比例：必须落在 (0, 1]，否则压缩要么从不触发要么立即触发 */
function unitRatio(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} 必须是 (0, 1] 之间的数值`);
  }
  return value;
}

function parseArgs(args) {
  let workspace;
  let allowShell = false;
  let sandbox = false;
  let sessionId;
  let resumeId;
  let checkpointDb;
  let projectId;
  const taskParts = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--workspace') {
      workspace = args[++i];
      if (!workspace) throw new Error('--workspace 需要目录参数');
    } else if (arg === '--allow-shell') {
      allowShell = true;
    } else if (arg === '--docker' || arg === '--sandbox') {
      sandbox = true;
    } else if (arg === '--session' || arg === '--resume' || arg === '--checkpoint-db' || arg === '--project') {
      const value = args[++i];
      if (!value) throw new Error(`${arg} 需要参数`);
      if (arg === '--session') sessionId = value;
      else if (arg === '--resume') resumeId = value;
      else if (arg === '--project') projectId = value;
      else checkpointDb = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知选项: ${arg}`);
    } else {
      taskParts.push(arg);
    }
  }
  if (sessionId && resumeId) throw new Error('--session 与 --resume 不能同时使用');
  if (sandbox && allowShell) {
    throw new Error('--docker 与 --allow-shell 不能同时使用：前者有隔离，后者没有，混用会让人误判边界');
  }
  for (const [label, id] of [['会话', sessionId], ['会话', resumeId], ['项目', projectId]]) {
    if (id && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
      throw new Error(`${label} ID 只能包含字母、数字、下划线和连字符，最长 64 字符`);
    }
  }
  if (!resumeId && !workspace) throw new Error('必须用 --workspace 指定任务目录');
  if (!resumeId && !taskParts.length) throw new Error('缺少任务内容');
  if (resumeId && taskParts.length) throw new Error('恢复会话时不再传入任务内容');
  if (checkpointDb && !sessionId && !resumeId && !projectId) {
    throw new Error('--checkpoint-db 需要配合 --session、--resume 或 --project');
  }
  return { workspace, allowShell, sandbox, sessionId, resumeId, checkpointDb, projectId,
    task: taskParts.join(' ') };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const useSandbox = options.docker;
  if (useSandbox) {
    // 沙箱说「有隔离」就必须真的有：拿不到 Docker 时直接退出，不做静默降级
    const report = await inspectDocker({ dockerBinary: config.dockerBinary, image: config.dockerImage });
    if (!report.ok) {
      throw new Error(`${report.reason}\n需要临时关闭隔离时改用 --allow-shell（仅限可信目录）。`);
    }
    console.error(`沙箱: ${report.image}（Docker ${report.serverVersion}），网络关闭，仅挂载工作区`);
  }
  const dbPath = resolve(options.checkpointDb ?? '.agent-harness/checkpoints.sqlite');
  if (options.resumeId && !existsSync(dbPath)) throw new Error(`checkpoint 数据库不存在: ${dbPath}`);
  if (options.sessionId || (options.projectId && !options.resumeId)) {
    const root = realpathSync(resolve(options.workspace));
    const dbRelative = relative(root, dbPath);
    if (!dbRelative.startsWith('..') && !isAbsolute(dbRelative)) {
      throw new Error('checkpoint 数据库不能放在 Agent 工作区内');
    }
  }
  const store = options.sessionId || options.resumeId || options.projectId
    ? createCheckpointStore(dbPath) : null;
  try {
    const session = options.resumeId ? store.load(options.resumeId) : null;
    if (session?.status === 'completed') throw new Error(`会话已完成: ${options.resumeId}`);
    if (session && options.workspace && realpathSync(resolve(options.workspace)) !== session.workspace) {
      throw new Error('恢复会话的工作区与原会话不一致');
    }
    if (session && options.allowShell && !session.allowShell) {
      throw new Error('恢复时不能为原会话新增 --allow-shell 权限');
    }
    if (session && options.projectId && options.projectId !== session.projectId) {
      throw new Error('恢复会话的项目 ID 与原会话不一致');
    }
    const workspaceRoot = realpathSync(resolve(session?.workspace ?? options.workspace));
    if (!statSync(workspaceRoot).isDirectory()) throw new Error('工作区不是目录');
    if (existsSync(join(workspaceRoot, '.env'))) {
      throw new Error('工作区根目录含 .env，请使用不含凭据的独立任务目录');
    }
    if (store) {
      const dbRelative = relative(workspaceRoot, realpathSync(store.path));
      if (!dbRelative.startsWith('..') && !isAbsolute(dbRelative)) {
        throw new Error('checkpoint 数据库不能放在 Agent 工作区内');
      }
    }

    const task = session?.task ?? options.task;
    const projectId = session?.projectId ?? options.projectId ?? null;
    const sessionId = options.sessionId ?? options.resumeId ?? (projectId ? randomUUID() : null);
    // 执行后端：恢复会话时沿用原会话的模式；沙箱比原模式更严，允许中途加上
    const sandbox = Boolean(session?.sandbox) || options.sandbox;
    const allowShell = sandbox ? false : (session?.allowShell ?? options.allowShell);
    let memoryContext = '';
    if (store && !session && projectId) {
      const remembered = relevantEpisodes(store.recentEpisodes(projectId), task);
      memoryContext = renderEpisodes(remembered);
    }
    const initialState = session?.state
      ?? (store ? createInitialAgentState(task, undefined, memoryContext) : undefined);
    const model = createOpenAICompatibleModel({
      model: process.env.MODEL_NAME ?? process.env.OPENAI_MODEL,
      apiKey: process.env.MODEL_API_KEY ?? process.env.OPENAI_API_KEY,
      baseURL: process.env.MODEL_BASE_URL ?? process.env.OPENAI_BASE_URL,
      maxRetries: config.modelMaxRetries,
    });
    const registry = createToolRegistry({ workspaceRoot }, {
      includeExecCommand: allowShell,
      sandbox: sandbox ? {
        image: config.dockerImage,
        memory: config.dockerMemory,
        cpus: config.dockerCpus,
        pidsLimit: config.dockerPidsLimit,
        user: config.dockerUser,
        dockerBinary: config.dockerBinary,
      } : null,
    });
    const maxTurns = positiveInt('AGENT_MAX_TURNS', 12);
    const maxDurationMs = positiveInt('AGENT_MAX_DURATION_MS', 120_000);
    const maxContextChars = positiveInt('AGENT_MAX_CONTEXT_CHARS', 120_000);
    const softContextRatio = unitRatio('AGENT_CONTEXT_SOFT_RATIO', DEFAULT_SOFT_CONTEXT_RATIO);
    const keepRecentTurns = positiveInt('AGENT_KEEP_RECENT_TURNS', DEFAULT_KEEP_RECENT_TURNS);
    if (store && !session) {
      store.create({ id: sessionId, workspace: workspaceRoot, task, allowShell, sandbox, projectId,
        state: initialState });
    }
    if (store) console.error(`会话 ${sessionId}；checkpoint: ${store.path}`);
    if (sandbox) console.error(`执行后端: Docker 沙箱（${config.dockerImage}）`);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const result = await runAgent({
      task,
      model,
      registry,
      initialState,
      onCheckpoint: store ? (state) => store.save(sessionId, state) : undefined,
      maxTurns,
      maxDurationMs,
      maxContextChars,
      softContextRatio,
      keepRecentTurns,
      signal: controller.signal,
      onEvent(event) {
        if (event.type === 'model') console.error(`第 ${event.turn} 轮: 模型返回 ${event.toolCalls} 个工具调用`);
        if (event.type === 'tool') console.error(`工具 ${event.name} (${event.callId}): ${event.outcome}`);
        if (event.type === 'batch') {
          console.error(`第 ${event.turn} 轮: ${event.calls} 个工具调用并发执行`);
        }
        if (event.type === 'context') {
          console.error(`第 ${event.turn} 轮: 上下文达 ${event.chars} 字符，压缩 ${event.levels.length} 级`
            + `（省 ${event.savedChars} 字符，丢弃 ${event.droppedTurns} 轮），估算 ${event.estimatedTokens} token`);
        }
      },
    });

    if (store) {
      store.save(sessionId, result.state, result.status, result.answer,
        projectId ? episodeFromResult(task, result) : null);
    }

    if (result.answer) console.log(result.answer);
    console.error(`运行状态: ${result.status}；${result.reason}`);
    if (result.status !== 'completed') process.exitCode = 1;
  } finally {
    store?.close();
  }
}

main().catch((err) => {
  console.error(`启动失败: ${err?.message ?? err}`);
  console.error(usage());
  process.exitCode = 1;
});
