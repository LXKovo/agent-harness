import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function exactFile(workspaceRoot, filePath, expected) {
  try {
    const actual = await readFile(join(workspaceRoot, filePath), 'utf8');
    return {
      name: `${filePath} 内容正确`,
      passed: actual === expected,
      detail: actual === expected
        ? `严格等于 ${JSON.stringify(expected)}`
        : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    };
  } catch (err) {
    return { name: `${filePath} 内容正确`, passed: false, detail: `无法读取: ${err.message}` };
  }
}

async function exactRootEntries(workspaceRoot, expected) {
  const actual = (await readdir(workspaceRoot)).sort();
  const wanted = [...expected].sort();
  return {
    name: '没有多余的根目录文件',
    passed: JSON.stringify(actual) === JSON.stringify(wanted),
    detail: `期望 ${wanted.join(', ')}；实际 ${actual.join(', ')}`,
  };
}

export const evalCases = [
  {
    id: 'create-exact-file',
    title: '创建内容精确的文件',
    task: [
      '在工作区根目录创建 result.txt。',
      '文件内容必须严格为 hello，不添加引号、代码块、解释或额外换行。',
      '完成后读取文件确认。',
    ].join(''),
    async setup() {},
    async check({ workspaceRoot }) {
      return [
        await exactFile(workspaceRoot, 'result.txt', 'hello'),
        await exactRootEntries(workspaceRoot, ['result.txt']),
      ];
    },
  },
  {
    id: 'transform-existing-file',
    title: '读取并转换已有文件',
    task: [
      '读取工作区根目录的 input.txt，将每一行转换为大写并保持原有行序，',
      '把结果写入 result.txt，不要修改 input.txt。',
      'result.txt 结尾不要增加额外换行。完成后读取两个文件确认。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await writeFile(join(workspaceRoot, 'input.txt'), 'red\nblue', 'utf8');
    },
    async check({ workspaceRoot }) {
      return [
        await exactFile(workspaceRoot, 'input.txt', 'red\nblue'),
        await exactFile(workspaceRoot, 'result.txt', 'RED\nBLUE'),
        await exactRootEntries(workspaceRoot, ['input.txt', 'result.txt']),
      ];
    },
  },
];

export function selectEvalCases(ids = []) {
  if (ids.length === 0) return evalCases;
  const requested = new Set(ids);
  const selected = evalCases.filter((testCase) => requested.has(testCase.id));
  const missing = ids.filter((id) => !selected.some((testCase) => testCase.id === id));
  if (missing.length) {
    throw new Error(`未知测评: ${missing.join(', ')}。可用测评: ${evalCases.map((item) => item.id).join(', ')}`);
  }
  return selected;
}
