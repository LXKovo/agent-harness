import { open } from 'node:fs/promises';
import { z } from 'zod';
import { resolveExistingPath } from './filePaths.js';

export function createReadFileTool({ workspaceRoot, maxOutputChars }) {
  return {
    name: 'read_file',
    description: '读取工作区内一个 UTF-8 文本文件。返回文件内容；过长时只返回开头并标明截断。',
    schema: z.object({
      filePath: z.string().min(1).describe('工作区内的文件路径'),
    }),

    async invoke({ filePath }) {
      try {
        const path = await resolveExistingPath(filePath, workspaceRoot);
        const file = await open(path, 'r');
        try {
          if (!(await file.stat()).isFile()) {
            return `读取文件失败: ${filePath} — 不是普通文件`;
          }

          const decoder = new TextDecoder('utf-8', { fatal: true });
          const buffer = Buffer.alloc(8192);
          let content = '';
          let truncated = false;

          while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) {
              try {
                content += decoder.decode();
              } catch {
                return `读取文件失败: ${filePath} — 文件不是有效的 UTF-8 文本`;
              }
              break;
            }
            if (buffer.subarray(0, bytesRead).includes(0)) {
              return `读取文件失败: ${filePath} — 不支持二进制文件`;
            }
            try {
              content += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
            } catch {
              return `读取文件失败: ${filePath} — 文件不是有效的 UTF-8 文本`;
            }
            if (content.length > maxOutputChars) {
              truncated = true;
              content = content.slice(0, maxOutputChars);
              // 不把 UTF-16 代理对切成半个字符。
              if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
              break;
            }
          }

          return [
            `文件: ${filePath}`,
            '--- content ---',
            content || '(空文件)',
            ...(truncated ? [`(内容超过 ${maxOutputChars} 字符，已截断)`] : []),
          ].join('\n');
        } finally {
          await file.close();
        }
      } catch (err) {
        return `读取文件失败: ${filePath} — ${err.message}`;
      }
    },
  };
}
