import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { relative } from 'node:path';
import { z } from 'zod';
import { resolveInWorkspace, SandboxError } from '../safety/sandbox.js';
import { toolResult, withToolResult } from './result.js';
import { formatResult, resolveTimeoutMs } from './execCommand.js';

/**
 * 沙箱执行工具：命令在一次性 Docker 容器里跑
 *
 * 与 exec_command 的差别只有执行位置，结果版式完全一致（复用 formatResult）。
 * 隔离手段逐条列在 buildRunArgs 的注释里；这一层的承诺是：
 *   - 只有工作区被挂载进来，根文件系统只读
 *   - 容器没有网络
 *   - 命令结束（或超时、取消）后容器被删除，不留状态
 */

/** 容器内的工作目录 —— 工作区永远挂到这里，模型看到的路径必须是容器内路径 */
export const CONTAINER_WORKDIR = '/workspace';

/** 本仓库创建的容器都带这个标签，用来识别并回收残留容器 */
export const CONTAINER_LABEL = 'agent-harness.sandbox=1';

/** 默认镜像：需要能跑 node 与 shell */
export const DEFAULT_IMAGE = 'node:22-alpine';

/** docker CLI 自身失败时常见的「容器不存在」提示，用于区分「已删」和「删失败」 */
const NO_SUCH_CONTAINER = /No such container|no such container/i;

/**
 * 组装 `docker run` 参数 —— 纯函数，便于离线单测
 *
 *   --network none                     容器没有网卡：读不到内网服务，也无法外传数据
 *   --cap-drop ALL                     丢掉全部 Linux capability
 *   --security-opt no-new-privileges   禁止 setuid 提权
 *   --read-only                        根文件系统只读，只有工作区与 /tmp 可写
 *   --tmpfs /tmp                       给需要临时文件的工具留一块内存盘
 *   --memory / --cpus / --pids-limit   限制资源，避免 fork 炸弹拖垮宿主
 *   --rm                               命令结束即删除容器
 *   --entrypoint sh                    不依赖镜像自带的 entrypoint
 *
 * `--user` 默认 root：挂载进来的工作区在宿主机上属于当前用户，
 * 容器里的非 root 用户往往写不进去。隔离由容器边界负责，不由容器内的用户负责。
 * 需要更严时设 AGENT_DOCKER_USER，但要保证工作区对该用户可写。
 */
export function buildRunArgs({
  containerName, image, workspace, cwdInContainer, command,
  workdir = CONTAINER_WORKDIR, memory = '1g', cpus = '1', pidsLimit = 256,
  user = '0:0', tmpfsSize = '64m',
}) {
  return [
    'run', '--rm',
    '--name', containerName,
    '--label', CONTAINER_LABEL,
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--memory', String(memory),
    '--cpus', String(cpus),
    '--pids-limit', String(pidsLimit),
    '--user', String(user),
    '--read-only',
    '--tmpfs', `/tmp:rw,size=${tmpfsSize},mode=1777`,
    '-v', `${workspace}:${workdir}:rw`,
    '-w', cwdInContainer,
    '--entrypoint', 'sh',
    image,
    '-c', command,
  ];
}

/** 组装删除容器参数；超时或取消后必须显式删，否则容器会在后台继续跑 */
export function buildRemoveArgs(containerName) {
  return ['rm', '-f', containerName];
}

/** 默认的 docker 调用：捕获输出与退出码，支持超时与取消 */
export function spawnDocker(dockerBinary, args, { timeoutMs, signal, maxOutputChars = 20_000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(dockerBinary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let closeResult;
    let killTimer;

    const append = (current, chunk) => {
      if (current.length >= maxOutputChars) {
        truncated = true;
        // 继续消费但不累积，否则管道写满会把 docker 卡死
        return current;
      }
      const text = chunk.toString();
      const room = maxOutputChars - current.length;
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
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, truncated, durationMs: Date.now() - startedAt, ...extra });
    };
    const stop = (reason) => {
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ ok: false, code: null, error: reason });
    };
    const onAbort = () => stop('docker 调用已取消');
    const timer = timeoutMs ? setTimeout(() => stop(`docker 调用超过 ${timeoutMs}ms`), timeoutMs) : null;
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.on('error', (err) => finish({ ok: false, code: null, error: err.message }));
    child.on('close', (code) => {
      closeResult = { ok: code === 0, code, error: null, truncated };
      finish(closeResult);
    });
  });
}

/**
 * 回收上次运行残留的容器
 *
 * 进程被强杀时 --rm 可能来不及生效，容器会留在 daemon 里继续占资源。
 * 每次执行前先按标签清一次：自己收拾自己的残留，不依赖运气。
 */
export async function reapOrphanContainers({ dockerBinary = 'docker', dockerExec = spawnDocker } = {}) {
  const listed = await dockerExec(dockerBinary,
    ['ps', '-aq', '--filter', `label=${CONTAINER_LABEL}`], { timeoutMs: 20_000 });
  if (!listed.ok) {
    return { ok: false, error: `${listed.stderr || listed.error || '未知错误'}`.trim().split('\n')[0] };
  }
  const ids = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (ids.length === 0) return { ok: true, removed: 0 };
  const removed = await dockerExec(dockerBinary, ['rm', '-f', ...ids], { timeoutMs: 30_000 });
  return removed.ok
    ? { ok: true, removed: ids.length }
    : { ok: false, error: `${removed.stderr || removed.error || '未知错误'}`.trim().split('\n')[0] };
}

/**
 * 删除一个容器；先按名字删，失败再用残留回收兜底
 *
 * 为什么不能只在结束时删一次：docker CLI 被强杀后容器仍在运行，
 * 名字删除可能因为 race 失败，所以要有一条按标签兜底的路径。
 */
export async function removeContainer(containerName, { dockerBinary = 'docker', dockerExec = spawnDocker } = {}) {
  const removed = await dockerExec(dockerBinary, buildRemoveArgs(containerName), { timeoutMs: 30_000 });
  if (removed.ok || NO_SUCH_CONTAINER.test(`${removed.stderr}${removed.error ?? ''}`)) {
    return { ok: true };
  }
  // 名字删除失败（例如 docker CLI 被强杀后的竞态）时按标签兜底；
  // 但兜底必须真的删掉了东西才算成功，否则会把失败说成成功。
  const reaped = await reapOrphanContainers({ dockerBinary, dockerExec });
  if (reaped.ok && reaped.removed > 0) return { ok: true, viaReaper: reaped.removed };
  return { ok: false, error: `${removed.stderr || removed.error || '删除容器失败'}`.trim().split('\n')[0] };
}

/**
 * 创建沙箱执行工具
 */
export function createDockerCommandTool({
  workspaceRoot,
  image = DEFAULT_IMAGE,
  defaultTimeoutMs,
  maxTimeoutMs,
  maxOutputChars,
  memory,
  cpus,
  pidsLimit,
  user,
  dockerBinary = 'docker',
  dockerExec = spawnDocker,
}) {
  return withToolResult({
    name: 'exec_command',

    description: [
      '在一次性 Docker 容器中执行一条命令，返回它的 stdout / stderr / 退出码。',
      `容器只挂载当前工作区，根文件系统只读，并且没有网络；容器内工作目录是 ${CONTAINER_WORKDIR}。`,
      'cwd 只能是工作区内的相对路径，越界会被拒绝。',
    ].join(' '),

    schema: z.object({
      command: z.string().min(1).describe('要执行的命令（在容器内由 sh -c 执行）'),
      cwd: z.string().optional().describe('工作目录（工作区内相对路径），省略时为工作区根目录'),
      timeoutMs: z.number().int().positive().optional()
        .describe(`超时毫秒数，默认 ${defaultTimeoutMs}，上限 ${maxTimeoutMs}`),
      reason: z.string().optional().describe('执行这条命令的原因，便于事后审计'),
    }),

    async invoke({ command, cwd, timeoutMs }, { signal } = {}) {
      // 1. 路径边界：cwd 必须在工作区内，并换算成容器内路径
      let cwdInContainer = CONTAINER_WORKDIR;
      try {
        const resolved = cwd ? resolveInWorkspace(cwd, { root: workspaceRoot }) : workspaceRoot;
        const relativeCwd = relative(workspaceRoot, resolved).replaceAll('\\', '/').replace(/^\/+/, '');
        if (relativeCwd) cwdInContainer = `${CONTAINER_WORKDIR}/${relativeCwd}`;
      } catch (err) {
        if (err instanceof SandboxError) {
          return toolResult('rejected', `命令未执行 —— ${err.message}`);
        }
        throw err;
      }

      // 2. 超时封顶（与 exec_command 共用同一套规则）
      const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs, { defaultTimeoutMs, maxTimeoutMs });

      // 3. 先回收残留容器，拿不到 Docker 就不要执行
      const reaped = await reapOrphanContainers({ dockerBinary, dockerExec });
      if (!reaped.ok) {
        return toolResult('error', [
          `命令未执行 —— 无法确认沙箱可用: ${reaped.error}`,
          '请检查 Docker 是否在运行（docker ps），并确认镜像已拉取。',
        ].join('\n'));
      }

      // 4. 在容器里执行；给 docker CLI 留出比命令本身更长的等待时间
      const containerName = `agent-harness-sandbox-${randomUUID().slice(0, 12)}`;
      const result = await dockerExec(dockerBinary, buildRunArgs({
        containerName, image, workspace: workspaceRoot, cwdInContainer, command,
        memory, cpus, pidsLimit, user,
      }), {
        timeoutMs: effectiveTimeoutMs + 15_000,
        signal,
        maxOutputChars: maxOutputChars * 2,
      });

      // 5. 结束即删除：超时、取消、docker CLI 自身失败都要删
      const cleanup = await removeContainer(containerName, { dockerBinary, dockerExec });

      const output = formatResult({
        command,
        cwd: cwdInContainer,
        result,
        effectiveTimeoutMs,
        maxOutputChars,
      });
      const notes = [
        `沙箱: ${image}，网络已关闭，容器 ${containerName} 已删除`,
      ];
      if (result.error) notes.push(`docker 调用问题: ${result.error}`);
      if (!cleanup.ok) notes.push(`警告: 删除容器失败 — ${cleanup.error}`);
      const status = result.ok && cleanup.ok ? (result.truncated ? 'truncated' : 'success') : 'error';
      return toolResult(status, [output, ...notes].join('\n'), { truncated: result.truncated });
    },
  });
}

/**
 * 启动前的可用性检查
 *
 * 沙箱是硬前置：拿不到 Docker 就不该带着「以为有隔离」的错觉去执行命令。
 * 这里只报告事实，由 CLI 决定报错退出还是提示用户。
 */
export async function inspectDocker({ dockerBinary = 'docker', image = DEFAULT_IMAGE, dockerExec = spawnDocker } = {}) {
  const info = await dockerExec(dockerBinary, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
  if (!info.ok) {
    const detail = `${info.stderr || info.error || '未知错误'}`.trim().split('\n')[0];
    return { ok: false, reason: `无法连接 Docker: ${detail}`, image };
  }
  const images = await dockerExec(dockerBinary, ['images', '--format', '{{.Repository}}:{{.Tag}}'], { timeoutMs: 20_000 });
  const available = images.ok
    ? images.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];
  if (!available.includes(image)) {
    return {
      ok: false,
      reason: `本地没有镜像 ${image}，先拉取：docker pull ${image}`,
      image,
      available,
    };
  }
  return { ok: true, serverVersion: info.stdout.trim(), image, available };
}
