import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveWritePath } from './filePaths.js';

export function createWriteFileTool({ workspaceRoot, maxWriteChars }) {
  return {
    name: 'write_file',
    description: '写入工作区内一个 UTF-8 文本文件。默认只创建新文件；覆盖已有文件须明确传 overwrite=true。不会自动创建父目录。',
    schema: z.object({
      filePath: z.string().min(1).describe('工作区内的文件路径'),
      content: z.string().max(maxWriteChars).describe(`写入的完整文本，最多 ${maxWriteChars} 字符`),
      overwrite: z.boolean().optional().describe('设为 true 才允许覆盖已有文件'),
    }),

    async invoke({ filePath, content, overwrite = false }) {
      try {
        if (typeof content !== 'string' || content.length > maxWriteChars) {
          return `写入文件失败: ${filePath} — 内容超过 ${maxWriteChars} 字符上限`;
        }
        if (content.includes('\0')) {
          return `写入文件失败: ${filePath} — 不支持包含 NUL 字符的文本`;
        }
        const target = await resolveWritePath(filePath, workspaceRoot);

        if (!overwrite) {
          await writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
          return `已创建文件: ${filePath} (${Buffer.byteLength(content)} 字节)`;
        }

        let existing;
        try {
          existing = await lstat(target);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        if (existing?.isSymbolicLink()) {
          return `写入文件失败: ${filePath} — 不允许覆盖符号链接`;
        }
        if (existing && !existing.isFile()) {
          return `写入文件失败: ${filePath} — 目标不是普通文件`;
        }

        // 在同一目录写临时文件，再替换目标，避免覆盖中途留下半份内容。
        const temp = join(dirname(target), `.agent-harness-${randomUUID()}.tmp`);
        let created = false;
        try {
          const file = await open(temp, 'wx', existing?.mode ?? 0o666);
          created = true;
          try {
            await file.writeFile(content, { encoding: 'utf8' });
          } finally {
            await file.close();
          }
          await rename(temp, target);
        } finally {
          if (created) await rm(temp, { force: true });
        }

        return `已${existing ? '覆盖' : '创建'}文件: ${filePath} (${Buffer.byteLength(content)} 字节)`;
      } catch (err) {
        return `写入文件失败: ${filePath} — ${err.message}`;
      }
    },
  };
}
