import { ToolRegistry } from './registry.js';
import { createExecCommandTool } from './execCommand.js';
import { createReadFileTool } from './readFile.js';
import { createListDirectoryTool } from './listDirectory.js';
import { createWriteFileTool } from './writeFile.js';
import { config } from '../config.js';

/**
 * 组装内置工具集
 *
 * 每个工具在这里同时登记「它自己」和「它的结果处理器」。
 * 新增工具 = 加一个文件 + 在这里多一行，不需要动任何路由代码。
 *
 * @param {object} [overrides] - 覆盖 config 中的字段（测试用）
 * @returns {ToolRegistry}
 */
export function createToolRegistry(overrides = {}) {
  const settings = { ...config, ...overrides };
  const registry = new ToolRegistry();

  registry.register(createExecCommandTool({
    ...settings,
    defaultTimeoutMs: settings.commandTimeoutMs,
    maxTimeoutMs: settings.maxCommandTimeoutMs,
  }), {
    // 终端只显示首行（成功/失败/超时那行），完整输出留给模型
    summarize: (result) => result.split('\n')[0],
    compact: (result) => result,
  });

  const fileProcessors = {
    summarize: (result) => result.split('\n')[0],
    compact: (result) => result,
  };
  registry.register(createReadFileTool(settings), fileProcessors);
  registry.register(createListDirectoryTool(settings), fileProcessors);
  registry.register(createWriteFileTool(settings), fileProcessors);

  return registry;
}
