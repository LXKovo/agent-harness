import { spawn } from 'node:child_process';
import { z } from 'zod';
import { resolveInWorkspace, SandboxError } from '../safety/sandbox.js';
import { toolResult, withToolResult } from './result.js';

/**
 * 杀掉子进程及其整棵进程树
 *
 * 为什么不能只写 child.kill()：
 *   Windows 上 kill() 只终止 shell 本身，shell 拉起的「孙进程」会残留
 *   ——`pnpm install` 起了 node，node 又起了自己的子进程，杀 shell 等于没杀。
 *   必须用 taskkill /t 才会连整棵树一起收。
 *
 * 这是「超时」里最容易被漏掉的一半：光停止等待没有用，
 * 进程还在后台占着 CPU 和端口。
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ ok: true });
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let errorOutput = Buffer.alloc(0);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        killer.kill();
        killer.stderr.destroy();
        killer.unref();
        finish({ ok: false, error: 'taskkill 超时' });
      }, 5000);

      killer.stderr.on('data', (chunk) => {
        errorOutput = Buffer.concat([errorOutput, chunk.subarray(0, 1000 - errorOutput.length)]);
      });
      killer.on('error', (err) => finish({ ok: false, error: err.message }));
      killer.on('close', (code) => {
        if (code === 0) return finish({ ok: true });
        let detail;
        try {
          detail = new TextDecoder('utf-8', { fatal: true }).decode(errorOutput);
        } catch {
          // 中文 Windows 的 taskkill 常用 GBK 输出，直接按 UTF-8 解码会乱码。
          detail = new TextDecoder('gbk').decode(errorOutput);
        }
        finish({ ok: false, error: `taskkill 退出码 ${code}: ${detail.trim()}` });
      });
    });
  }

  try {
    return Promise.resolve(child.kill('SIGKILL')
      ? { ok: true }
      : { ok: false, error: 'SIGKILL 未发送成功' });
  } catch (err) {
    return Promise.resolve({ ok: false, error: err.message });
  }
}

/**
 * 超时封顶 —— 纯函数，便于单测
 *
 * 工具允许模型自己指定 timeoutMs，但必须封顶：否则模型可以填一个
 * 近乎无限的值，把「超时保护」变成摆设。
 */
export function resolveTimeoutMs(requested, { defaultTimeoutMs, maxTimeoutMs }) {
  if (requested === undefined || requested === null) {
    return defaultTimeoutMs;
  }
  return Math.min(requested, maxTimeoutMs);
}

/**
 * 执行命令并捕获输出
 *
 * 与 min-cursor 的一个关键差异：这里用 pipe 捕获 stdout/stderr 并随结果返回。
 * min-cursor 用的是 `stdio: 'inherit'`——输出只打在终端上，**模型看不到**。
 * 于是模型执行 `ls` 后拿不到任何文件列表，只能靠猜。
 * Agent 要能干活，就必须让它看见命令的输出。
 */
function spawnCaptured(command, { cwd, shell, timeoutMs, maxOutputChars, terminateProcessTree, signal }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) {
      if (/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:$|_)/i.test(name)) {
        delete childEnv[name];
      }
    }
    const child = spawn(command, {
      cwd,
      shell,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let terminationPending = false;
    let closeResult;
    let closeTimer;

    const append = (current, chunk) => {
      if (current.length >= maxOutputChars) {
        truncated = true;
        // 继续消费但不累积：不消费的话管道写满会把子进程卡死
        return current;
      }

      const text = chunk.toString();
      const room = maxOutputChars - current.length;

      // 单个 chunk 就可能超过上限（管道会攒一大块再一次性投递），
      // 所以这里必须真的切片——光判断「累积前是否已满」是不够的
      if (text.length > room) {
        truncated = true;
        return current + text.slice(0, room);
      }

      return current + text;
    };

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        truncated,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
    };

    const releaseChild = () => {
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };

    const requestStop = (reason) => {
      if (settled || terminationPending || closeResult) return;
      if (reason === 'timeout') timedOut = true;
      else aborted = true;
      terminationPending = true;
      Promise.resolve().then(() => terminateProcessTree(child)).then((status) => {
        terminationPending = false;
        if (!status.ok) {
          releaseChild();
          finish({ ok: false, code: null, signal: null, terminationError: status.error });
        } else if (closeResult) {
          finish(closeResult);
        } else {
          // taskkill 成功后仍需等子进程关闭；不能无限等待失联的管道。
          closeTimer = setTimeout(() => {
            releaseChild();
            finish({ ok: false, code: null, signal: null, terminationError: '未确认进程退出' });
          }, 2000);
        }
      }).catch((err) => {
        terminationPending = false;
        releaseChild();
        finish({ ok: false, code: null, signal: null, terminationError: err.message });
      });
    };
    const onAbort = () => requestStop('abort');
    const timer = setTimeout(() => requestStop('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.on('error', (err) => finish({ ok: false, code: null, signal: null, error: err.message }));
    child.on('close', (code, signal) => {
      closeResult = { ok: !timedOut && !aborted && code === 0, code, signal, error: null };
      if (!terminationPending) finish(closeResult);
    });
  });
}

/**
 * 把执行结果整理成一段模型能读懂的文本
 */
function formatResult({ command, cwd, result, effectiveTimeoutMs, maxOutputChars }) {
  const lines = [];

  if (result.timedOut) {
    lines.push(result.terminationError
      ? `命令超时（${effectiveTimeoutMs}ms），终止进程失败: ${command} — ${result.terminationError}`
      : `命令超时（${effectiveTimeoutMs}ms），已终止进程树: ${command}`);
  } else if (result.aborted) {
    lines.push(result.terminationError
      ? `命令已取消，终止进程失败: ${command} — ${result.terminationError}`
      : `命令已取消: ${command}`);
  } else if (result.error) {
    lines.push(`命令无法启动: ${command} — ${result.error}`);
  } else if (result.ok) {
    lines.push(`命令执行成功: ${command} (${result.durationMs}ms)`);
  } else {
    const signal = result.signal ? `，信号 ${result.signal}` : '';
    lines.push(`命令执行失败: ${command} — 退出码 ${result.code}${signal}`);
  }

  lines.push(`工作目录: ${cwd}`);

  if (result.stdout) {
    lines.push('--- stdout ---', result.stdout.replace(/\s+$/, ''));
  }
  if (result.stderr) {
    lines.push('--- stderr ---', result.stderr.replace(/\s+$/, ''));
  }
  if (!result.stdout && !result.stderr) {
    lines.push('(无输出)');
  }
  if (result.truncated) {
    lines.push(`(输出超过 ${maxOutputChars} 字符，已截断)`);
  }

  return lines.join('\n');
}

/**
 * 创建 exec_command 工具
 *
 * @param {object} deps
 * @param {string} deps.workspaceRoot - 工作区根目录（沙箱边界）
 * @param {string|true} deps.shell - 执行命令用的 shell
 * @param {number} deps.defaultTimeoutMs
 * @param {number} deps.maxTimeoutMs
 * @param {number} deps.maxOutputChars
 * @param {Function} [deps.terminateProcessTree] - 进程终止函数（供测试注入失败场景）
 */
export function createExecCommandTool({
  workspaceRoot,
  shell,
  defaultTimeoutMs,
  maxTimeoutMs,
  maxOutputChars,
  terminateProcessTree = killTree,
}) {
  return withToolResult({
    name: 'exec_command',

    description: [
      '在 shell 中执行一条命令并返回它的 stdout / stderr / 退出码。',
      'Windows 上使用 Git Bash，支持管道、重定向与 && 串联。',
      'cwd 只能是工作区内的相对路径，越界会被拒绝。',
    ].join(' '),

    schema: z.object({
      command: z.string().min(1).describe('要执行的命令'),
      cwd: z.string().optional().describe('工作目录（工作区内相对路径），省略时为工作区根目录'),
      timeoutMs: z.number().int().positive().optional()
        .describe(`超时毫秒数，默认 ${defaultTimeoutMs}，上限 ${maxTimeoutMs}`),
      reason: z.string().optional().describe('执行这条命令的原因，便于事后审计'),
    }),

    async invoke({ command, cwd, timeoutMs }, { signal } = {}) {
      // 1. 沙箱：解析工作目录
      let resolvedCwd;
      try {
        resolvedCwd = cwd ? resolveInWorkspace(cwd, { root: workspaceRoot }) : workspaceRoot;
      } catch (err) {
        if (err instanceof SandboxError) {
          return toolResult('rejected', `命令未执行 —— ${err.message}`);
        }
        throw err;
      }

      // 2. 超时封顶
      const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs, { defaultTimeoutMs, maxTimeoutMs });

      // 3. 执行
      const result = await spawnCaptured(command, {
        cwd: resolvedCwd,
        shell,
        timeoutMs: effectiveTimeoutMs,
        maxOutputChars,
        terminateProcessTree,
        signal,
      });

      const status = result.ok ? (result.truncated ? 'truncated' : 'success') : 'error';
      return toolResult(status,
        formatResult({ command, cwd: resolvedCwd, result, effectiveTimeoutMs, maxOutputChars }),
        { truncated: result.truncated });
    },
  });
}
