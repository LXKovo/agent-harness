import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { resolveExistingPath } from './filePaths.js';

const SKIPPED_NAMES = new Set(['.git', 'node_modules']);

function displayPath(workspaceRoot, absolutePath) {
  const path = relative(workspaceRoot, absolutePath) || '.';
  return path.split(sep).join('/');
}

async function readSearchableText(path, maxBytes) {
  const file = await open(path, 'r');
  try {
    // 最多读取上限加一个字节，文件即使在扫描期间增长也不会突破内存预算。
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return { text: null, tooLarge: true };
    const content = buffer.subarray(0, bytesRead);
    if (content.includes(0)) return { text: null, tooLarge: false };
    try {
      return {
        text: new TextDecoder('utf-8', { fatal: true }).decode(content),
        tooLarge: false,
      };
    } catch {
      return { text: null, tooLarge: false };
    }
  } finally {
    await file.close();
  }
}

export function createSearchFilesTool({
  workspaceRoot,
  maxOutputChars,
  maxSearchFiles = 2_000,
  maxSearchFileBytes = 1_000_000,
}) {
  return {
    name: 'search_files',
    description: '在工作区文件中递归搜索单行字面量文本，返回路径、行号、列号和匹配行。跳过符号链接、二进制文件、超大文件、.git 和 node_modules。',
    schema: z.object({
      query: z.string().min(1).max(1_000).refine(
        (value) => !/[\r\n]/.test(value),
        'query 必须是单行文本',
      ).describe('要查找的字面量文本，不是正则表达式'),
      path: z.string().min(1).optional().describe('起始文件或目录，省略时搜索整个工作区'),
      caseSensitive: z.boolean().optional().describe('是否区分大小写，默认为 true'),
      maxResults: z.number().int().min(1).max(100).optional().describe('最多返回多少条匹配，默认为 50'),
    }),

    async invoke({ query, path = '.', caseSensitive = true, maxResults = 50 }) {
      try {
        const start = await resolveExistingPath(path, workspaceRoot);
        const startStat = await stat(start);
        const files = [];
        let scannedFiles = 0;
        let skippedLargeFiles = 0;
        let hitFileLimit = false;

        async function collect(candidate, candidateStat = null) {
          if (files.length >= maxSearchFiles) {
            hitFileLimit = true;
            return;
          }
          const currentStat = candidateStat ?? await stat(candidate);
          if (currentStat.isFile()) {
            files.push(candidate);
            return;
          }
          if (!currentStat.isDirectory()) return;

          const entries = await readdir(candidate, { withFileTypes: true });
          entries.sort((left, right) => left.name.localeCompare(right.name));
          for (const entry of entries) {
            if (files.length >= maxSearchFiles) {
              hitFileLimit = true;
              break;
            }
            if (entry.isSymbolicLink()) continue;
            if (SKIPPED_NAMES.has(entry.name)) continue;
            if (entry.isDirectory() || entry.isFile()) {
              await collect(join(candidate, entry.name));
            }
          }
        }

        await collect(start, startStat);
        const needle = caseSensitive ? query : query.toLowerCase();
        const matches = [];
        let usedChars = 0;
        let truncated = false;

        for (const file of files) {
          if (matches.length >= maxResults || usedChars >= maxOutputChars) {
            truncated = true;
            break;
          }
          const { text: content, tooLarge } = await readSearchableText(file, maxSearchFileBytes);
          if (tooLarge) {
            skippedLargeFiles += 1;
            continue;
          }
          scannedFiles += 1;
          if (content === null) continue;
          const lines = content.split(/\r\n?|\n/);
          for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
            const haystack = caseSensitive ? lines[lineIndex] : lines[lineIndex].toLowerCase();
            let offset = 0;
            while (true) {
              const column = haystack.indexOf(needle, offset);
              if (column === -1) break;
              const preview = lines[lineIndex].length > 300
                ? `${lines[lineIndex].slice(0, 300)}…`
                : lines[lineIndex];
              const line = `${displayPath(workspaceRoot, file)}:${lineIndex + 1}:${column + 1}: ${preview}`;
              if (matches.length >= maxResults || usedChars + line.length + 1 > maxOutputChars) {
                truncated = true;
                break;
              }
              matches.push(line);
              usedChars += line.length + 1;
              offset = column + Math.max(query.length, 1);
            }
            if (truncated) break;
          }
          if (truncated) break;
        }

        return [
          `搜索: ${JSON.stringify(query)}，起点: ${path}`,
          ...(matches.length ? matches : ['(没有匹配)']),
          `已扫描 ${scannedFiles} 个文本候选文件，找到 ${matches.length} 处匹配`,
          ...(skippedLargeFiles ? [`跳过 ${skippedLargeFiles} 个超过 ${maxSearchFileBytes} 字节的文件`] : []),
          ...(hitFileLimit ? [`达到 ${maxSearchFiles} 个文件的扫描上限`] : []),
          ...(truncated ? ['(结果已达到数量或输出长度上限)'] : []),
        ].join('\n');
      } catch (err) {
        return `搜索文件失败: ${path} — ${err.message}`;
      }
    },
  };
}
