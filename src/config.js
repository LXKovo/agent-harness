import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * exec_command 使用的 shell
 *
 * 优先 SHELL_PATH；Windows 上探测常见 Git Bash 安装位置，找不到就交给系统默认 shell。
 * 为什么非要 bash：LLM 训练数据里的 shell 示例绝大多数是 bash 语法，
 * 让它写 PowerShell / cmd 命令的准确率会明显下降。
 */
function detectShell() {
  if (process.env.SHELL_PATH) {
    return process.env.SHELL_PATH;
  }

  if (process.platform !== 'win32') {
    return true;
  }

  const programFilesX86 = process.env['ProgramFiles(x86)'];

  const candidates = [
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    programFilesX86 && join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
    'D:\\Git\\Git\\bin\\bash.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || true;
}

export const config = {
  /**
   * 工作区根目录 —— 文件类工具的路径边界
   *
   * 默认是 harness 自己所在目录，真正使用时应该指向「让 agent 操作的那个项目」，
   * 例如：WORKSPACE_ROOT=/path/to/my-project
   */
  workspaceRoot: process.env.WORKSPACE_ROOT || resolve(__dirname, '..'),

  /** 命令执行使用的 shell */
  shell: detectShell(),

  /** 单条命令的默认超时（毫秒）—— 没有它，一条挂住的命令能让 agent 永久等待 */
  commandTimeoutMs: parseInt(process.env.COMMAND_TIMEOUT) || 30_000,

  /**
   * 模型可自行指定的超时上限（毫秒）
   *
   * 工具允许模型传 timeoutMs，但必须封顶：否则模型可以给自己开一个
   * 近乎无限的超时，把「超时保护」变成摆设。
   */
  maxCommandTimeoutMs: parseInt(process.env.MAX_COMMAND_TIMEOUT) || 600_000,

  /** 单条命令返回给模型的最大字符数（超出截断，避免一次输出撑爆上下文） */
  maxOutputChars: parseInt(process.env.MAX_OUTPUT_CHARS) || 8_000,

  /** write_file 单次可写入的最大字符数 */
  maxWriteChars: parseInt(process.env.MAX_WRITE_CHARS) || 100_000,

  /** search_files 单次最多检查的文件数和单文件字节数 */
  maxSearchFiles: parseInt(process.env.MAX_SEARCH_FILES) || 2_000,
  maxSearchFileBytes: parseInt(process.env.MAX_SEARCH_FILE_BYTES) || 1_000_000,

  /**
   * 沙箱执行（Docker）
   *
   * 命令在一次性容器里跑：只挂载工作区、根文件系统只读、没有网络。
   * 这里的是资源上限与镜像选择，不是「安全开关」——安全开关在 CLI 的 --docker。
   */
  dockerImage: process.env.AGENT_DOCKER_IMAGE || 'node:22-alpine',

  /** 容器内存上限（docker 的 --memory 语法，如 512m、2g） */
  dockerMemory: process.env.AGENT_DOCKER_MEMORY || '1g',

  /** 容器 CPU 上限（docker 的 --cpus 语法） */
  dockerCpus: process.env.AGENT_DOCKER_CPUS || '1',

  /** 容器进程数上限：防止 fork 炸弹把宿主拖垮 */
  dockerPidsLimit: parseInt(process.env.AGENT_DOCKER_PIDS) || 256,

  /**
   * 容器内以哪个用户运行，默认 root
   *
   * 挂载进来的工作区在宿主机上属于当前用户，容器里的非 root 用户
   * 往往写不进去。隔离由容器边界负责，不由容器内的用户负责。
   */
  dockerUser: process.env.AGENT_DOCKER_USER || '0:0',

  /** docker 可执行文件路径 */
  dockerBinary: process.env.AGENT_DOCKER_BINARY || 'docker',

  /**
   * 模型请求的重试次数
   *
   * 一次网络抖动不该让整次任务失败。重试只放在模型层：模型请求幂等，
   * 而工具可能有副作用，自动重试等于重复执行。
   * 代价是重试会消耗总耗时预算（AGENT_MAX_DURATION_MS）。
   */
  modelMaxRetries: Number.isSafeInteger(Number(process.env.AGENT_MODEL_MAX_RETRIES))
    ? Number(process.env.AGENT_MODEL_MAX_RETRIES)
    : 2,
};
