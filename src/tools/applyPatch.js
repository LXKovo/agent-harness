import { lstat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { replaceFileAtomically } from './atomicWrite.js';
import { resolveWritePath } from './filePaths.js';

function countOccurrences(content, search) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(search, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + search.length;
  }
}

function decodeText(buffer, filePath) {
  if (buffer.includes(0)) throw new Error('不支持二进制文件');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${filePath} 不是有效的 UTF-8 文本`);
  }
}

export function createApplyPatchTool({ workspaceRoot, maxWriteChars }) {
  const editSchema = z.object({
    oldText: z.string().min(1).max(maxWriteChars).describe('必须与文件中现有文本精确匹配'),
    newText: z.string().max(maxWriteChars).describe('替换后的文本，可以为空字符串'),
    replaceAll: z.boolean().optional().describe('设为 true 时替换该旧文本的全部匹配'),
  });

  return {
    name: 'apply_patch',
    description: '局部修改工作区内一个现有 UTF-8 文本文件。按顺序执行精确文本替换；默认要求每段旧文本只出现一次，全部校验成功后才原子写入。',
    schema: z.object({
      filePath: z.string().min(1).describe('工作区内的现有文件路径'),
      edits: z.array(editSchema).min(1).max(20).refine(
        (edits) => edits.reduce((total, edit) => total + edit.oldText.length + edit.newText.length, 0) <= maxWriteChars,
        `所有修改文本合计不能超过 ${maxWriteChars} 字符`,
      ),
    }),

    async invoke({ filePath, edits }) {
      try {
        const target = await resolveWritePath(filePath, workspaceRoot);
        const existing = await lstat(target);
        if (existing.isSymbolicLink()) {
          return `修改文件失败: ${filePath} — 不允许修改符号链接`;
        }
        if (!existing.isFile()) {
          return `修改文件失败: ${filePath} — 目标不是普通文件`;
        }
        if (existing.size > maxWriteChars * 4) {
          return `修改文件失败: ${filePath} — 现有文件超过可修改大小上限`;
        }

        let content = decodeText(await readFile(target), filePath);
        if (content.length > maxWriteChars) {
          return `修改文件失败: ${filePath} — 现有文件超过 ${maxWriteChars} 字符上限`;
        }
        let replacementCount = 0;
        for (let index = 0; index < edits.length; index += 1) {
          const { oldText, newText, replaceAll = false } = edits[index];
          if (oldText.includes('\0') || newText.includes('\0')) {
            return `修改文件失败: ${filePath} — 第 ${index + 1} 项包含 NUL 字符`;
          }
          const occurrences = countOccurrences(content, oldText);
          if (occurrences === 0) {
            return `修改文件失败: ${filePath} — 第 ${index + 1} 项旧文本未找到`;
          }
          if (!replaceAll && occurrences !== 1) {
            return `修改文件失败: ${filePath} — 第 ${index + 1} 项旧文本出现 ${occurrences} 次，请提供更多上下文或设置 replaceAll=true`;
          }
          content = replaceAll
            ? content.split(oldText).join(newText)
            : content.replace(oldText, newText);
          replacementCount += replaceAll ? occurrences : 1;
          if (content.length > maxWriteChars) {
            return `修改文件失败: ${filePath} — 修改后内容超过 ${maxWriteChars} 字符上限`;
          }
        }

        await replaceFileAtomically(target, content, existing.mode);
        return `已修改文件: ${filePath} (${replacementCount} 处替换，${Buffer.byteLength(content)} 字节)`;
      } catch (err) {
        return `修改文件失败: ${filePath} — ${err.message}`;
      }
    },
  };
}
