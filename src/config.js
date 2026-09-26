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
};
