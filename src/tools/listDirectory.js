import { opendir } from 'node:fs/promises';
import { z } from 'zod';
import { resolveExistingPath } from './filePaths.js';
import { toolError, toolResult, withToolResult } from './result.js';

export function createListDirectoryTool({ workspaceRoot, maxOutputChars }) {
  return withToolResult({
    name: 'list_directory',
    description: '列出工作区内一个目录的直接子项，不递归。标明文件、目录和符号链接；结果过长时截断。',
    schema: z.object({
      path: z.string().min(1).optional().describe('工作区内的目录路径，省略时为工作区根目录'),
    }),

    async invoke({ path = '.' }) {
      try {
        const realPath = await resolveExistingPath(path, workspaceRoot);
        const entries = [];
        let usedChars = 0;
        let truncated = false;

        for await (const entry of await opendir(realPath)) {
          const type = entry.isDirectory() ? '目录'
            : entry.isFile() ? '文件'
              : entry.isSymbolicLink() ? '链接' : '其他';
          const line = `${type}\t${entry.name}`;
          if (usedChars + line.length + 1 > maxOutputChars) {
            truncated = true;
            break;
          }
          entries.push(line);
          usedChars += line.length + 1;
        }

        return toolResult(truncated ? 'truncated' : 'success', [
          `目录: ${path}`,
          ...entries,
          ...(!entries.length && !truncated ? ['(空目录)'] : []),
          ...(truncated ? [`(列表超过 ${maxOutputChars} 字符，已截断)`] : []),
        ].join('\n'), { truncated });
      } catch (err) {
        return toolError(`列出目录失败: ${path} — ${err.message}`, err);
      }
    },
  });
}
