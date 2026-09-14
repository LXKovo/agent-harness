import { resolve, relative, isAbsolute, sep } from 'node:path';

/**
 * 路径沙箱 —— 确保模型给的路径落在工作区内
 *
 * 为什么需要：路径是模型生成的，它完全可能写出
 *   write_file({ filePath: "C:\\Windows\\System32\\drivers\\etc\\hosts" })
 *   read_file({ filePath: "../../.ssh/id_rsa" })
 * 这类调用不会报错，会真的执行。
 *
 * ⚠️ 边界说明（别把它当安全沙箱）
 *   这一层只管「路径」，不管「进程」。exec_command 依然能在系统任意位置
 *   运行命令、读写任意文件——因为它走的是 shell，不经过路径校验。
 *   真正的进程级隔离需要容器（Docker / Firejail / Windows Sandbox）。
 *   所以这份实现的作用是：拦住模型「走错路」，而不是拦住「恶意代码」。
 */

export class SandboxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * 把路径解析成工作区内的绝对路径
 *
 * @param {string} inputPath - 相对或绝对路径
 * @param {object} opts
 * @param {string} opts.root - 工作区根目录（必须是绝对路径）
 * @param {string} [opts.base] - 解析「相对路径」时的基准目录，默认等于 root
 * @returns {string} 工作区内的绝对路径
 * @throws {SandboxError} 路径为空、root 非绝对路径、或路径越出工作区时
 */
export function resolveInWorkspace(inputPath, { root, base = root } = {}) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new SandboxError('路径不能为空');
  }

  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new SandboxError(`工作区根目录必须是绝对路径，收到: ${root}`);
  }

  // 绝对路径一律相对 root 解析（而不是相对 cwd），保证可预期
  const baseDir = isAbsolute(inputPath) ? root : base;
  const absolute = resolve(baseDir, inputPath);
  const rel = relative(root, absolute);

  // rel === '' 表示就是 root 本身；
  // 以 '..' 开头（或正好是 '..'）表示跳出了工作区
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SandboxError(`路径越出工作区: ${inputPath}`);
  }

  return absolute;
}

/**
 * 布尔版：只关心「在不在工作区内」，不关心原因
 * @returns {boolean}
 */
export function isInWorkspace(inputPath, opts) {
  try {
    resolveInWorkspace(inputPath, opts);
    return true;
  } catch {
    return false;
  }
}
