import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

async function nodeTestsPass(workspaceRoot) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--test'], {
      cwd: workspaceRoot,
      timeout: 10_000,
      windowsHide: true,
    });
    const summary = `${stdout}\n${stderr}`.split('\n').find((line) => /tests?\s+\d+/i.test(line));
    return { name: 'node --test 通过', passed: true, detail: summary?.trim() || '退出码为 0' };
  } catch (err) {
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim();
    return {
      name: 'node --test 通过',
      passed: false,
      detail: output ? output.slice(-500) : err.message,
    };
  }
}

const SHELL_FIXTURE_PACKAGE = `${JSON.stringify({
  name: 'agent-harness-eval-fixture',
  private: true,
  type: 'module',
  scripts: { test: 'node --test' },
}, null, 2)}\n`;

const SHELL_FIXTURE_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from '../src/add.js';",
  '',
  "test('add returns the sum', () => {",
  '  assert.equal(add(2, 3), 5);',
  '  assert.equal(add(-1, 1), 0);',
  '});',
  '',
].join('\n');

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
  {
    id: 'repair-code-and-test',
    title: '修复代码并运行测试',
    allowShell: true,
    task: [
      '这是一个小型 Node.js 项目。读取现有源码和测试，修复 src/add.js 中的错误，',
      '使 node --test 通过。不要修改 package.json 或 test/add.test.js，也不要新增文件。',
      '修改后必须使用 exec_command 运行 node --test，并根据输出确认结果。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'src'));
      await mkdir(join(workspaceRoot, 'test'));
      await writeFile(join(workspaceRoot, 'package.json'), SHELL_FIXTURE_PACKAGE, 'utf8');
      await writeFile(join(workspaceRoot, 'src', 'add.js'), [
        'export function add(left, right) {',
        '  return left - right;',
        '}',
        '',
      ].join('\n'), 'utf8');
      await writeFile(join(workspaceRoot, 'test', 'add.test.js'), SHELL_FIXTURE_TEST, 'utf8');
    },
    async check({ workspaceRoot, agentResult }) {
      const usedExecCommand = agentResult?.events.some(
        (event) => event.type === 'tool' && event.name === 'exec_command',
      );
      return [
        await exactFile(workspaceRoot, 'package.json', SHELL_FIXTURE_PACKAGE),
        await exactFile(workspaceRoot, 'test/add.test.js', SHELL_FIXTURE_TEST),
        await nodeTestsPass(workspaceRoot),
        {
          name: 'Agent 实际运行了测试',
          passed: Boolean(usedExecCommand),
          detail: usedExecCommand ? '检测到 exec_command 调用' : '没有检测到 exec_command 调用',
        },
        await exactRootEntries(workspaceRoot, ['package.json', 'src', 'test']),
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
