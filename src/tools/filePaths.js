import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { resolveInWorkspace, SandboxError } from '../safety/sandbox.js';

async function realWorkspaceRoot(workspaceRoot) {
  return realpath(workspaceRoot);
}

function checkRealPath(realPath, realRoot, inputPath) {
  try {
    resolveInWorkspace(realPath, { root: realRoot });
  } catch (err) {
    if (err instanceof SandboxError) {
      throw new SandboxError(`路径通过符号链接越出工作区: ${inputPath}`);
    }
    throw err;
  }
}

/** 读已有文件或目录时，检查词法路径和符号链接指向的真实路径。 */
export async function resolveExistingPath(inputPath, workspaceRoot) {
  const absolute = resolveInWorkspace(inputPath, { root: workspaceRoot });
  const realRoot = await realWorkspaceRoot(workspaceRoot);
  const realPath = await realpath(absolute);
  checkRealPath(realPath, realRoot, inputPath);
  return realPath;
}

/** 写入时目标可以不存在；解析父目录，避免通过目录链接写到工作区外。 */
export async function resolveWritePath(inputPath, workspaceRoot) {
  const absolute = resolveInWorkspace(inputPath, { root: workspaceRoot });
  const realRoot = await realWorkspaceRoot(workspaceRoot);
  const realParent = await realpath(dirname(absolute));
  checkRealPath(realParent, realRoot, inputPath);
  return join(realParent, basename(absolute));
}
