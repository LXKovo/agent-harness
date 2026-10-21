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

/**
 * 大面积探索夹具：60 个模块，总量越过上下文硬预算
 *
 * 目的不是「模型会不会写代码」，而是检验单 Agent 在「必须检索、不能通读」
 * 的仓库里能否找到唯一真值：全部模块合计远超 120000 字符预算，逐个通读必然
 * 触发压缩；正确路径是先 search_files 定位、再定向 read_file。
 *
 * 夹具里还有 8 个同形常量做诱饵：宽泛搜索 `_ENDPOINT` 会命中 9 处，
 * 只有精确搜索常量名才能唯一命中。这条路径若稳定失败，才是引入子 Agent 的
 * 证据（准入条件见 DESIGN.md D14）。
 */
const EXPLORATION_AREAS = [
  { area: 'edge', pad: 'E' },
  { area: 'billing', pad: 'B' },
  { area: 'search', pad: 'S' },
  { area: 'jobs', pad: 'J' },
  { area: 'auth', pad: 'A' },
  { area: 'catalog', pad: 'C' },
];
const EXPLORATION_MODULES_PER_AREA = 10;

/** 目标常量放在 edge-3，其余 8 个是同形诱饵，值互不相同 */
const EXPLORATION_ENDPOINTS = [
  { area: 'edge', index: 0, name: 'EU_WEST_1_ENDPOINT', value: 'https://api.eu-west-1.harness.example/v1' },
  { area: 'edge', index: 3, name: 'EU_WEST_3_ENDPOINT', value: 'https://api.eu-west-3.harness.example/v2' },
  { area: 'edge', index: 9, name: 'EU_WEST_2_ENDPOINT', value: 'https://api.eu-west-2.harness.example/v1' },
  { area: 'billing', index: 2, name: 'EU_CENTRAL_1_ENDPOINT', value: 'https://api.eu-central-1.harness.example/v1' },
  { area: 'billing', index: 8, name: 'EU_SOUTH_1_ENDPOINT', value: 'https://api.eu-south-1.harness.example/v1' },
  { area: 'search', index: 5, name: 'US_EAST_1_ENDPOINT', value: 'https://api.us-east-1.harness.example/v1' },
  { area: 'jobs', index: 1, name: 'AP_SOUTH_1_ENDPOINT', value: 'https://api.ap-south-1.harness.example/v1' },
  { area: 'auth', index: 7, name: 'US_WEST_2_ENDPOINT', value: 'https://api.us-west-2.harness.example/v1' },
  { area: 'catalog', index: 4, name: 'EU_NORTH_1_ENDPOINT', value: 'https://api.eu-north-1.harness.example/v1' },
];

const EXPLORATION_README = [
  '# 服务仓库',
  '',
  'src/services 下按区域分为六个目录，共 60 个服务模块。',
  '每个模块导出一个处理函数和一个归一化函数。',
  '',
  '维护约定：查找常量请使用检索工具，不要逐个文件通读。',
  '',
].join('\n');

function buildExplorationFiles() {
  const files = new Map();
  for (const { area, pad } of EXPLORATION_AREAS) {
    for (let index = 0; index < EXPLORATION_MODULES_PER_AREA; index += 1) {
      files.set(
        `src/services/${area}/${area}-${index}.js`,
        buildLargeModule({
          name: `${area}${index}`,
          title: `${area} 区域模块 ${index}`,
          sections: 10,
          pad,
        }),
      );
    }
  }
  for (const endpoint of EXPLORATION_ENDPOINTS) {
    const path = `src/services/${endpoint.area}/${endpoint.area}-${endpoint.index}.js`;
    // buildLargeModule 以换行结尾，这里直接追加，保证常量独占一行、可被字面量搜索命中
    files.set(path, `${files.get(path)}export const ${endpoint.name} = '${endpoint.value}';\n`);
  }
  files.set('README.md', EXPLORATION_README);
  return files;
}

const EXPLORATION_FILES = buildExplorationFiles();
const EXPLORATION_TARGET = EXPLORATION_ENDPOINTS.find(
  (endpoint) => endpoint.name === 'EU_WEST_3_ENDPOINT',
);

/**
 * 「必须通读」夹具：24 个大型模块，合计约 134KB
 *
 * 与 explore-large-repo 互补：那个任务点名了常量，一次精确字面量搜索就能定位，
 * 所以它只能检验「会不会用检索」。这个任务要比较每个模块首行审计记录末尾的 weight。
 *
 * 审计行的形状刻意让「命中 / 未命中」不再是可用的 oracle：
 * - weight 是整行最后 8 个十进制字符，前面没有 `"weight":` 这样的可检索键；
 * - 封条长度在 300..360 之间逐模块变化，weight 的起始列不是固定值；
 * - 封条最后一位强制为 a-f，读文件时能看清字母与 8 位数字的边界。
 * search_files 只接受字面量、每行只回显前 300 字符，因此它既看不到 weight，
 * 也无法用「某个前缀命中了」逐位缩小范围；要比较只能 read_file 逐个读取。
 *
 * 为什么审计行放在文件开头、weight 又控制在 1200 字符以内：L1 压缩会把工具结果
 * 截到 1200 字符，放在更深处会同时测到「压缩截断」和「要不要通读」两件事，
 * 失败时无法归因。这里刻意只保留一个变量 —— 必须逐个读文件。
 *
 * 24 个文件合计越过 120000 字符的默认硬预算，读取过程必然触发上下文压缩，
 * 这正是要观察的场景：压缩之后模型还能不能保住「目前见过的最大值」。
 */
const SWEEP_AREAS = ['edge', 'billing', 'search', 'jobs', 'auth', 'catalog'];
const SWEEP_MODULES_PER_AREA = 4;
const SWEEP_SECTIONS = 20;
const SWEEP_AUDIT_PREFIX = '// audit: ';
const SWEEP_AUDIT_SEAL_MIN = 300;
const SWEEP_AUDIT_SEAL_MAX = 360;
const SWEEP_MAX = { area: 'jobs', index: 2, weight: 64_210_000 };

/** 除最大值外，权重是 10_000_000..10_000_036 的 8 位整数，比较时不容易和封条里的数字混淆 */
function sweepWeight(areaIndex, index) {
  return 10_000_000 + ((areaIndex * 7 + index * 13) % 37);
}

/** 确定性噪声：同样的种子永远得到同样的封条，夹具因此每次运行都逐字节一致 */
function sweepSeal(seed) {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  const length = SWEEP_AUDIT_SEAL_MIN
    + (state % (SWEEP_AUDIT_SEAL_MAX - SWEEP_AUDIT_SEAL_MIN + 1));
  let seal = '';
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    seal += '0123456789abcdef'[state % 16];
  }
  // 最后一位固定为字母，读文件时能一眼区分封条结尾和 8 位权重
  return `${seal.slice(0, -1)}${'abcdef'[state % 6]}`;
}

function buildSweepModule({ area, areaIndex, index }) {
  const name = `${area}${index}`;
  const source = buildLargeModule({
    name,
    title: `${area} 区域模块 ${index}`,
    sections: SWEEP_SECTIONS,
    pad: area[0].toUpperCase(),
  });
  const module = `${area}-${index}.js`;
  const weight = area === SWEEP_MAX.area && index === SWEEP_MAX.index
    ? SWEEP_MAX.weight
    : sweepWeight(areaIndex, index);
  // 审计行独占文件第一行：search_files 按行回显前 300 字符，权重在行末因此不在检索结果里；
  // 而它整行不到 400 字符，read_file 的内容即使被 L1 截到 1200 字符也仍完整。
  return `${SWEEP_AUDIT_PREFIX}${module} ${sweepSeal(module)}${String(weight).padStart(8, '0')}\n${source}`;
}

const SWEEP_FILES = new Map();
for (const [areaIndex, area] of SWEEP_AREAS.entries()) {
  for (let index = 0; index < SWEEP_MODULES_PER_AREA; index += 1) {
    SWEEP_FILES.set(
      `src/services/${area}/${area}-${index}.js`,
      buildSweepModule({ area, areaIndex, index }),
    );
  }
}
SWEEP_FILES.set('README.md', [
  '# 服务仓库',
  '',
  `src/services 下按区域分为六个目录，共 ${SWEEP_AREAS.length * SWEEP_MODULES_PER_AREA} 个服务模块。`,
  '每个模块开头有一行以 `// audit: ` 开头的审计记录：模块名、一段 300–360 位的十六进制封条，',
  '以及紧跟在封条后的 8 位十进制权重。整行最后 8 个字符就是 weight。',
  '',
  '维护约定：审计记录由导出脚本生成，不要手工修改。',
  '',
].join('\n'));

const SWEEP_MAX_PATH = `src/services/${SWEEP_MAX.area}/${SWEEP_MAX.area}-${SWEEP_MAX.index}.js`;

/** 供离线测试与假模型使用，避免测试里重复写死夹具形状 */
export const sweepAuditFixture = {
  modules: [...SWEEP_FILES.keys()].filter((path) => path !== 'README.md'),
  maxPath: SWEEP_MAX_PATH,
  maxWeight: SWEEP_MAX.weight,
};

/** 夹具可能很大，60 个文件逐条检查会把报告和终端淹掉，这里聚合成一条 */
async function unchangedFiles(workspaceRoot, files) {
  const mismatched = [];
  for (const [path, expected] of files) {
    try {
      const actual = await readFile(join(workspaceRoot, path), 'utf8');
      if (actual !== expected) mismatched.push(path);
    } catch {
      mismatched.push(`${path}(缺失)`);
    }
  }
  return {
    name: `${files.size} 个夹具文件逐字节未变`,
    passed: mismatched.length === 0,
    detail: mismatched.length
      ? `有 ${mismatched.length} 个文件被改动: ${mismatched.slice(0, 5).join(', ')}`
      : `${files.size} 个文件全部未修改`,
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
  {
    id: 'explore-large-repo',
    title: '在 60 个模块中定位唯一端点常量',
    task: [
      '这个仓库有 60 个服务模块，按区域分布在 src/services 下。',
      '请找出常量 EU_WEST_3_ENDPOINT 定义在哪个文件，并写出它的完整值。',
      '最终回答必须同时包含定义它的文件路径和值本身。',
      '不要修改任何文件。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'src', 'services'), { recursive: true });
      for (const { area } of EXPLORATION_AREAS) {
        await mkdir(join(workspaceRoot, 'src', 'services', area));
      }
      await Promise.all(
        [...EXPLORATION_FILES].map(([path, content]) => writeFile(join(workspaceRoot, path), content, 'utf8')),
      );
    },
    async check({ workspaceRoot, agentResult }) {
      const answer = agentResult?.answer ?? '';
      const toolNames = agentResult?.events
        .filter((event) => event.type === 'tool')
        .map((event) => event.name) ?? [];
      const writes = toolNames.filter((name) => name === 'write_file' || name === 'apply_patch');
      return [
        {
          name: '回答包含端点常量的完整值',
          passed: answer.includes(EXPLORATION_TARGET.value),
          detail: `期望包含 ${EXPLORATION_TARGET.value}；回答: ${answer.slice(0, 120)}`,
        },
        {
          name: '回答指出定义该常量的文件',
          passed: /edge-3\.js/.test(answer),
          detail: `期望提到 edge-3.js；回答: ${answer.slice(0, 120)}`,
        },
        {
          name: 'Agent 用检索定位而不是通读',
          passed: toolNames.includes('search_files'),
          detail: `工具调用: ${toolNames.join(', ') || '(无)'}`,
        },
        {
          name: 'Agent 没有修改文件',
          passed: writes.length === 0,
          detail: writes.length ? `检测到写操作: ${writes.join(', ')}` : '未调用写工具',
        },
        await unchangedFiles(workspaceRoot, EXPLORATION_FILES),
        await exactRootEntries(workspaceRoot, ['README.md', 'src']),
      ];
    },
  },
  {
    id: 'sweep-audit-weights',
    title: '在 24 个大型模块中比对配置权重',
    // 24 次读取按每轮 4-6 个并发，默认 12 轮不够用。放宽轮数是为了让「上下文」
    // 而不是「轮数」成为变量：否则失败只能说明轮数太少，得不出任何结论。
    maxTurns: 16,
    // 参考解法（逐个读取 24 个文件）本机 50–95 秒完成；120 秒的全局上限在模型
    // 多探索几轮时就会先耗尽。240 秒是参考成本 ×3 左右的安全网，只兜慢请求，
    // 不判「快不快」——效率看轮数、工具调用和耗时本身。
    maxDurationMs: 240_000,
    task: [
      '这个仓库有 24 个服务模块，按区域分布在 src/services 下。',
      '每个模块开头有一行以 // audit: 开头的单行审计记录：模块名、一段十六进制封条，整行最后 8 个字符是该模块的十进制 weight。',
      '请找出 weight 最大的模块，回答它的文件路径和 weight 值。',
      '不要修改现有文件；如果需要记录中间结果，可以新建临时文件。',
    ].join(''),
    async setup({ workspaceRoot }) {
      await mkdir(join(workspaceRoot, 'src', 'services'), { recursive: true });
      for (const area of SWEEP_AREAS) {
        await mkdir(join(workspaceRoot, 'src', 'services', area));
      }
      await Promise.all(
        [...SWEEP_FILES].map(([path, content]) => writeFile(join(workspaceRoot, path), content, 'utf8')),
      );
    },
    async check({ workspaceRoot, agentResult }) {
      const answer = agentResult?.answer ?? '';
      // 只看结果，不要求「必须读了多少个文件」：旧夹具把 weight 放在可检索的
      // `"weight":` 字段里，有一轮用 search_files 的「命中 / 未命中」逐位试探出了权重。
      // 新夹具把 weight 放在行末、去掉可检索键并让封条长度变化，这种试探不再能缩小范围；
      // 但检查器仍不按策略判分，只核对最终答案和文件是否被改动。
      return [
        {
          name: '回答指出 weight 最大的模块',
          passed: new RegExp(`${SWEEP_MAX.area}-${SWEEP_MAX.index}\\.js`).test(answer),
          detail: `期望提到 ${SWEEP_MAX.area}-${SWEEP_MAX.index}.js；回答: ${answer.slice(0, 120)}`,
        },
        {
          name: `回答包含最大权重 ${SWEEP_MAX.weight}`,
          passed: answer.includes(String(SWEEP_MAX.weight)),
          detail: `期望包含 ${SWEEP_MAX.weight}；回答: ${answer.slice(0, 120)}`,
        },
        await unchangedFiles(workspaceRoot, SWEEP_FILES),
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
