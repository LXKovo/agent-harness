import { ToolRegistry } from './registry.js';
import { createExecCommandTool } from './execCommand.js';
import { createDockerCommandTool } from './dockerCommand.js';
import { createReadFileTool } from './readFile.js';
import { createListDirectoryTool } from './listDirectory.js';
import { createSearchFilesTool } from './searchFiles.js';
import { createApplyPatchTool } from './applyPatch.js';
import { createWriteFileTool } from './writeFile.js';
import { config } from '../config.js';

/**
 * 组装内置工具集
 *
 * 每个工具在这里同时登记「它自己」和「它的结果处理器」。
 * 新增工具 = 加一个文件 + 在这里多一行，不需要动任何路由代码。
 *
 * 命令工具有两个互斥的后端，二者都占用 `exec_command` 这个名字：
 *   - 默认：进程内直接跑（快，但没有隔离）
 *   - sandbox：一次性 Docker 容器（有隔离，需要 Docker 与镜像）
 * 具体提供哪一个由调用方决定；注册表不做隐式降级，避免「以为有隔离」。
 *
 * @param {object} [overrides] - 覆盖 config 中的字段（测试用）
 * @param {{includeExecCommand?: boolean, sandbox?: object}} [options]
 *   sandbox 存在时注册容器后端，此时 includeExecCommand 必须为 false
 * @returns {ToolRegistry}
 */
export function createToolRegistry(overrides = {}, { includeExecCommand = true, sandbox = null } = {}) {
  const settings = { ...config, ...overrides };
  const registry = new ToolRegistry();

  if (sandbox && includeExecCommand) {
    throw new Error('沙箱后端与进程内命令后端互斥，不能同时注册');
  }

  const commandProcessors = {
    // 终端只显示首行（成功/失败/超时那行），完整输出留给模型
    summarize: (result) => result.split('\n')[0],
    compact: (result) => result,
  };

  if (sandbox) {
    registry.register(createDockerCommandTool({
      ...settings,
      defaultTimeoutMs: settings.commandTimeoutMs,
      maxTimeoutMs: settings.maxCommandTimeoutMs,
      ...sandbox,
    }), commandProcessors);
  } else if (includeExecCommand) {
    registry.register(createExecCommandTool({
      ...settings,
      defaultTimeoutMs: settings.commandTimeoutMs,
      maxTimeoutMs: settings.maxCommandTimeoutMs,
    }), commandProcessors);
  }

  const fileProcessors = {
    summarize: (result) => result.split('\n')[0],
    compact: (result) => result,
  };
  registry.register(createReadFileTool(settings), fileProcessors);
  registry.register(createListDirectoryTool(settings), fileProcessors);
  registry.register(createSearchFilesTool(settings), fileProcessors);
  registry.register(createApplyPatchTool(settings), fileProcessors);
  registry.register(createWriteFileTool(settings), fileProcessors);

  return registry;
}
