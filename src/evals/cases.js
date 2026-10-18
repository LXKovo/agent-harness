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

async function exactDirectoryEntries(workspaceRoot, directory, expected) {
  const actual = (await readdir(join(workspaceRoot, directory))).sort();
  const wanted = [...expected].sort();
  return {
    name: `${directory} 目录没有多余文件`,
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

const SEARCH_PATCH_SETTINGS_BEFORE = [
  'export const settings = {',
  '  featureEnabled: false,',
  '  retryCount: 2,',
  '};',
  '',
].join('\n');

const SEARCH_PATCH_SETTINGS_AFTER = SEARCH_PATCH_SETTINGS_BEFORE.replace(
  'featureEnabled: false',
  'featureEnabled: true',
);

const SEARCH_PATCH_NOTES = 'featureEnabled 由 src/settings.js 管理，请勿修改本文档。\n';

/**
 * 合成一个体积真实的源码文件。
 *
 * 夹具要制造的是「上下文压力」而不是「模型会不会写代码」：单个文件的体积
 * 超过 read_file 的输出上限，因此模型必须先搜索定位、再按需读取；
 * 而读到的内容会超过上下文压缩的上限，压缩是否伤害结果因此能被真实轨迹检验。
 */
function buildLargeModule({ name, title, sections, pad }) {
  const parts = [
    `// ${name}.js —— ${title}`,
    '// 本文件是测评夹具的合成代码，用于制造真实的上下文压力。',
    '',
  ];
  for (let index = 0; index < sections; index += 1) {
    const label = `${name}${pad}Step${index}`;
    parts.push(`// 步骤 ${index}：${name} 在阶段 ${pad} 的处理分支，注释保持单行以便搜索。`);
    parts.push(`export function ${label}(input, options = {}) {`);
    parts.push('  const normalized = normalize(input);');
    parts.push(`  const limit = options.limit ?? ${(index % 7) + 1};`);
    parts.push(`  return { label: '${label}', normalized, limit, trace: ['${name}', 'step${index}'] };`);
    parts.push('}');
    parts.push('');
  }
  parts.push('export function normalize(value) {');
  parts.push("  return String(value ?? '').trim();");
  parts.push('}');
  parts.push('');
  return parts.join('\n');
}

const LARGE_MODULE_SECTIONS = 300;
const VEGA_SOURCE = buildLargeModule({ name: 'vega', title: '前台报表模块', sections: LARGE_MODULE_SECTIONS, pad: 'A' });
const AURORA_SOURCE = buildLargeModule({ name: 'aurora', title: '后台任务模块', sections: LARGE_MODULE_SECTIONS, pad: 'B' });

const LARGE_MODULE_CONFIG_BEFORE = [
  '// 构建期配置：本文件末尾是唯一的真值来源。',
  'export const buildConfig = {',
  "  bundleName: 'aurora-worker',",
  "  target: 'node22',",
  '  retryBase: 7,',
  '  timeoutMs: SERVICE_TIMEOUT_MS,',
  '  sourcemap: false,',
  '};',
  '',
  'export const SERVICE_TIMEOUT_MS = 30_000;',
  '',
].join('\n');
const LARGE_MODULE_CONFIG_AFTER = LARGE_MODULE_CONFIG_BEFORE.replace(
  'SERVICE_TIMEOUT_MS = 30_000',
  'SERVICE_TIMEOUT_MS = 5_000',
);

const RELEASE_TOKEN_SLOT = 'M-6600';
const RELEASE_NOTES = [
  '# 发布说明',
  '',
  '本文档只描述发布流程，不记录任何令牌。',
  '令牌登记在 config/release.js 中，请以那里的值为准。',
  '',
].join('\n');
const REGISTRY_SOURCE = buildLargeModule({ name: 'registry', title: '服务注册表', sections: 20, pad: 'R' });

/**
 * 沙箱夹具：一个依赖网络安装的项目
 *
 * package.json 声明的依赖刻意不在工作区里，所以 `npm install` 必须联网。
 * 沙箱把网络关掉，因此这一步必然失败 —— 失败本身就是「容器确实没有网」的证据。
 */
const SANDBOX_FIXTURE_PACKAGE = `${JSON.stringify({
  name: 'agent-harness-sandbox-fixture',
  private: true,
  type: 'module',
  scripts: {
    test: 'node --test',
    // 依赖刻意装不上：沙箱没有网络，这一步必然失败，失败本身就是隔离生效的证据。
    // 探测脚本带超时，比直接 npm install 快得多（后者会走 npm 自己的长重试）。
    probe: 'node probe-network.js',
    install: 'npm install --no-audit --no-fund --fetch-retries=0 --fetch-timeout=5000',
  },
  dependencies: { 'left-pad': '1.3.0' },
}, null, 2)}\n`;

const SANDBOX_NETWORK_PROBE = [
  "// 网络探测：沙箱没有网络时这里会以非零码退出。",
  "import { lookup } from 'node:dns/promises';",
  '',
  'try {',
  "  await lookup('registry.npmjs.org');",
  "  console.log('NETWORK_REACHABLE');",
  '} catch (err) {',
  "  console.error(`NETWORK_UNREACHABLE: ${err.code ?? err.message}`);",
  '  process.exitCode = 1;',
  '}',
  '',
].join('\n');


const SANDBOX_TASK_NOTE = [
  '沙箱说明：命令在一次性 Docker 容器内执行。',
  '容器只挂载本工作区，根文件系统只读，并且没有网络。',
  '因此依赖网络的命令会失败，这属于预期行为，不是环境故障。',
  '',
].join('\n');
const RELEASE_CONFIG = [
  '// 发布记录：每个里程碑对应一个令牌。',
  'export const releaseRecords = [',
  "  { milestone: 'M-1000', token: 'W-1000' },",
  "  { milestone: 'M-2000', token: 'W-2000' },",
  "  { milestone: 'M-3000', token: 'W-3000' },",
  "  { milestone: 'M-4000', token: 'W-4000' },",
  `  { milestone: '${RELEASE_TOKEN_SLOT}', token: 'W-4471' },`,
  "  { milestone: 'M-7000', token: 'W-7000' },",
  '];',
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
    id: 'search-and-patch',
    title: '搜索并局部修改已有文件',
    task: [
      '在工作区中搜索包含 `featureEnabled: false` 的文件，读取并确认上下文，',
      '然后必须使用 apply_patch 将该处精确修改为 `featureEnabled: true`。',
      '不要使用 write_file，不要修改其他内容或新增文件。修改后读取文件确认结果。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'src'));
      await mkdir(join(workspaceRoot, 'docs'));
      await writeFile(join(workspaceRoot, 'src', 'settings.js'), SEARCH_PATCH_SETTINGS_BEFORE, 'utf8');
      await writeFile(join(workspaceRoot, 'docs', 'notes.txt'), SEARCH_PATCH_NOTES, 'utf8');
    },
    async check({ workspaceRoot, agentResult }) {
      const toolNames = agentResult?.events
        .filter((event) => event.type === 'tool')
        .map((event) => event.name) ?? [];
      return [
        await exactFile(workspaceRoot, 'src/settings.js', SEARCH_PATCH_SETTINGS_AFTER),
        await exactFile(workspaceRoot, 'docs/notes.txt', SEARCH_PATCH_NOTES),
        {
          name: 'Agent 使用了搜索和局部修改工具',
          passed: toolNames.includes('search_files') && toolNames.includes('apply_patch'),
          detail: `工具调用: ${toolNames.join(', ') || '(无)'}`,
        },
        {
          name: 'Agent 没有使用整文件写入',
          passed: !toolNames.includes('write_file'),
          detail: toolNames.includes('write_file') ? '检测到 write_file 调用' : '未调用 write_file',
        },
        await exactRootEntries(workspaceRoot, ['docs', 'src']),
        await exactDirectoryEntries(workspaceRoot, 'src', ['settings.js']),
        await exactDirectoryEntries(workspaceRoot, 'docs', ['notes.txt']),
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
  {
    id: 'edit-large-file',
    title: '在超长源码中定位并修改单个设置',
    task: [
      '这是一个小型 Node.js 服务仓库。读取 src/aurora.js 与 src/vega.js 了解结构，',
      '然后把 src/config.js 里 SERVICE_TIMEOUT_MS 的值从 30_000 改成 5_000，',
      '用 apply_patch 做最小修改。不要改动其他任何内容，不要新增或删除文件。',
      '修改后请读取 config.js 确认，并在最终回答中原样引用改动后的那一行。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'src'));
      await writeFile(join(workspaceRoot, 'src', 'vega.js'), VEGA_SOURCE, 'utf8');
      await writeFile(join(workspaceRoot, 'src', 'aurora.js'), AURORA_SOURCE, 'utf8');
      await writeFile(join(workspaceRoot, 'src', 'config.js'), LARGE_MODULE_CONFIG_BEFORE, 'utf8');
    },
    async check({ workspaceRoot, agentResult }) {
      const toolNames = agentResult?.events
        .filter((event) => event.type === 'tool')
        .map((event) => event.name) ?? [];
      const contextEvents = agentResult?.events.filter((event) => event.type === 'context') ?? [];
      return [
        await exactFile(workspaceRoot, 'src/config.js', LARGE_MODULE_CONFIG_AFTER),
        await exactFile(workspaceRoot, 'src/vega.js', VEGA_SOURCE),
        await exactFile(workspaceRoot, 'src/aurora.js', AURORA_SOURCE),
        {
          name: 'Agent 在修改前读取了超长源码',
          passed: toolNames.filter((name) => name === 'read_file').length >= 2,
          detail: `工具调用: ${toolNames.join(', ') || '(无)'}`,
        },
        {
          name: 'Agent 使用了局部修改',
          passed: toolNames.includes('apply_patch'),
          detail: toolNames.includes('apply_patch') ? '检测到 apply_patch' : '没有 apply_patch',
        },
        {
          name: '最终回答引用了改动后的行',
          passed: typeof agentResult?.answer === 'string'
            && agentResult.answer.includes('export const SERVICE_TIMEOUT_MS = 5_000;'),
          detail: `回答: ${(agentResult?.answer ?? '').slice(0, 120)}`,
        },
        {
          name: '上下文事件字段完整',
          passed: contextEvents.every((event) => typeof event.chars === 'number'
            && typeof event.savedChars === 'number'),
          detail: `context 事件 ${contextEvents.length} 个`,
        },
        await exactRootEntries(workspaceRoot, ['src']),
        await exactDirectoryEntries(workspaceRoot, 'src', ['aurora.js', 'config.js', 'vega.js']),
      ];
    },
  },
  {
    id: 'run-tests-in-sandbox',
    title: '在容器沙箱里修复代码并验证网络隔离',
    // 这个任务只在 --docker 模式下可解：命令必须进容器
    requiresSandbox: true,
    task: [
      SANDBOX_TASK_NOTE,
      '读取 src/multiply.js 与 test/multiply.test.js，修复源码让测试通过。',
      '不要修改 package.json 或测试文件，也不要新增文件。',
      '先用 exec_command 运行 node --test 确认通过，',
      '再运行 npm run probe 探测网络，在最终回答里说明网络是否可用以及原因。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'src'));
      await mkdir(join(workspaceRoot, 'test'));
      await writeFile(join(workspaceRoot, 'package.json'), SANDBOX_FIXTURE_PACKAGE, 'utf8');
      await writeFile(join(workspaceRoot, 'probe-network.js'), SANDBOX_NETWORK_PROBE, 'utf8');
      await writeFile(join(workspaceRoot, 'src', 'multiply.js'), [
        'export function multiply(left, right) {',
        '  return left + right;',
        '}',
        '',
      ].join('\n'), 'utf8');
      await writeFile(join(workspaceRoot, 'test', 'multiply.test.js'), [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { multiply } from '../src/multiply.js';",
        '',
        "test('multiply returns the product', () => {",
        '  assert.equal(multiply(3, 4), 12);',
        '  assert.equal(multiply(0, 5), 0);',
        '});',
        '',
      ].join('\n'), 'utf8');
    },
    async check({ workspaceRoot, agentResult }) {
      const events = agentResult?.events ?? [];
      const commands = events.filter((event) => event.type === 'tool' && event.name === 'exec_command');
      const answer = agentResult?.answer ?? '';
      return [
        await exactFile(workspaceRoot, 'src/multiply.js', [
          'export function multiply(left, right) {',
          '  return left * right;',
          '}',
          '',
        ].join('\n')),
        await exactFile(workspaceRoot, 'package.json', SANDBOX_FIXTURE_PACKAGE),
        await nodeTestsPass(workspaceRoot),
        {
          name: 'Agent 至少运行了两条命令（测试与安装）',
          passed: commands.length >= 2,
          detail: `exec_command 调用 ${commands.length} 次`,
        },
        {
          name: 'Agent 报告了网络不可用',
          passed: /没有网络|无网络|网络不可用|network|联网|离线|offline|ENOTFOUND|EAI_AGAIN/i.test(answer)
            && /probe|探测|npm install|安装/i.test(answer),
          detail: `回答: ${answer.slice(0, 160)}`,
        },
        await exactRootEntries(workspaceRoot, ['package.json', 'probe-network.js', 'src', 'test']),
        await exactDirectoryEntries(workspaceRoot, 'src', ['multiply.js']),
      ];
    },
  },
  {
    id: 'gather-token-across-files',
    title: '跨多个文件检索出唯一答案',
    task: [
      '在工作区中找出里程碑 M-6600 对应的发布令牌，',
      '并在最终回答中原样写出该令牌。',
      '只需要回答令牌本身，不要修改任何文件。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'config'));
      await mkdir(join(workspaceRoot, 'src'));
      await writeFile(join(workspaceRoot, 'config', 'release.js'), RELEASE_CONFIG, 'utf8');
      await writeFile(join(workspaceRoot, 'docs.md'), RELEASE_NOTES, 'utf8');
      await writeFile(join(workspaceRoot, 'src', 'registry.js'), REGISTRY_SOURCE, 'utf8');
    },
    async check({ workspaceRoot, agentResult }) {
      const answer = agentResult?.answer ?? '';
      return [
        {
          name: '回答里出现了正确的发布令牌',
          passed: answer.includes('W-4471'),
          detail: `回答: ${answer.slice(0, 120)}`,
        },
        await exactFile(workspaceRoot, 'config/release.js', RELEASE_CONFIG),
        await exactFile(workspaceRoot, 'docs.md', RELEASE_NOTES),
        await exactFile(workspaceRoot, 'src/registry.js', REGISTRY_SOURCE),
        await exactRootEntries(workspaceRoot, ['config', 'docs.md', 'src']),
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
