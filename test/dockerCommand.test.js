import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemoveArgs,
  buildRunArgs,
  CONTAINER_WORKDIR,
  createDockerCommandTool,
  inspectDocker,
  spawnDocker,
} from '../src/tools/dockerCommand.js';
import { createToolRegistry } from '../src/tools/index.js';

const runArgs = (overrides = {}) => buildRunArgs({
  containerName: 'agent-harness-sandbox-test',
  image: 'node:22-alpine',
  workspace: 'C:\\work',
  cwdInContainer: CONTAINER_WORKDIR,
  command: 'node --test',
  ...overrides,
});

test('容器参数包含全部隔离手段', () => {
  const args = runArgs();
  const pairs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--') || args[index] === '-v' || args[index] === '-w') {
      pairs.push([args[index], args[index + 1]]);
    }
  }
  const has = (flag, value) => pairs.some(([left, right]) => left === flag && right === value);
  assert.equal(has('--network', 'none'), true, '必须关闭网络');
  assert.equal(has('--cap-drop', 'ALL'), true, '必须丢掉全部 capability');
  assert.equal(has('--security-opt', 'no-new-privileges'), true);
  assert.equal(has('--read-only', undefined) || args.includes('--read-only'), true, '根文件系统必须只读');
  assert.equal(has('--memory', '1g'), true);
  assert.equal(has('--cpus', '1'), true);
  assert.equal(has('--pids-limit', '256'), true);
  assert.equal(has('--user', '0:0'), true);
  assert.equal(has('-v', 'C:\\work:/workspace:rw'), true, '只挂载工作区');
  assert.equal(has('-w', CONTAINER_WORKDIR), true);
  assert.equal(has('--entrypoint', 'sh'), true);
  assert.equal(args.includes('--rm'), true, '执行后必须删除容器');
  assert.equal(args.filter((value) => value === '-v').length, 1, '只能有一个挂载点');
});

test('命令作为最后一个参数传给 sh -c，不参与参数拼接', () => {
  const args = runArgs({ command: 'echo hi; rm -rf /workspace' });
  assert.equal(args.at(-1), 'echo hi; rm -rf /workspace');
  assert.equal(args.at(-2), '-c');
  // 命令内容不能变成 docker 自己的选项
  assert.equal(args.slice(0, -2).includes('echo hi; rm -rf /workspace'), false);
});

test('cwd 越界被拒绝，且在容器内仍是工作区路径', async () => {
  const tool = createDockerCommandTool({
    workspaceRoot: 'C:\\work',
    image: 'node:22-alpine',
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 5000,
    maxOutputChars: 1000,
    dockerExec: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  });
  const escaped = await tool.invokeResult?.({ command: 'ls', cwd: '../../etc' });
  assert.equal(escaped.status, 'rejected');
  assert.match(escaped.content, /越出工作区/);

  const runs = [];
  const recorded = createDockerCommandTool({
    workspaceRoot: 'C:\\work',
    image: 'node:22-alpine',
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 5000,
    maxOutputChars: 1000,
    dockerExec: async (binary, args) => {
      runs.push(args);
      return { ok: true, stdout: 'done\n', stderr: '', code: 0 };
    },
  });
  const ok = await recorded.invokeResult?.({ command: 'ls', cwd: 'src/tools' });
  assert.equal(ok.status, 'success');
  const runCall = runs.find((args) => args[0] === 'run');
  const workdirIndex = runCall.indexOf('-w');
  assert.equal(runCall[workdirIndex + 1], `${CONTAINER_WORKDIR}/src/tools`);
  assert.match(ok.content, /沙箱: node:22-alpine/);
  assert.match(ok.content, /容器 .* 已删除/);
});

test('每次执行前后都会清理：先回收残留，结束后删除本次容器', async () => {
  const calls = [];
  const tool = createDockerCommandTool({
    workspaceRoot: 'C:\\work',
    image: 'node:22-alpine',
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 5000,
    maxOutputChars: 1000,
    dockerExec: async (binary, args) => {
      calls.push(args);
      if (args[0] === 'ps') return { ok: true, stdout: 'orphan-1\n', stderr: '', code: 0 };
      return { ok: true, stdout: 'ok\n', stderr: '', code: 0 };
    },
  });
  await tool.invokeResult?.({ command: 'echo ok' });
  assert.equal(calls[0][0], 'ps', '先按标签列出残留容器');
  assert.equal(calls[1][0], 'rm', '残留容器必须被删除');
  assert.equal(calls[2][0], 'run');
  assert.equal(calls.at(-1)[0], 'rm', '本次容器必须被删除');
  assert.equal(calls.at(-1).includes('agent-harness-sandbox-'), false);
});

test('拿不到 Docker 时拒绝执行，而不是退回无隔离运行', async () => {
  const tool = createDockerCommandTool({
    workspaceRoot: 'C:\\work',
    image: 'node:22-alpine',
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 5000,
    maxOutputChars: 1000,
    dockerExec: async () => ({ ok: false, stdout: '', stderr: 'docker daemon not running', code: 1 }),
  });
  const result = await tool.invokeResult?.({ command: 'echo hi' });
  assert.equal(result.status, 'error');
  assert.match(result.content, /无法确认沙箱可用/);
});

test('删除容器失败会被报告出来，不会静默吞掉', async () => {
  const tool = createDockerCommandTool({
    workspaceRoot: 'C:\\work',
    image: 'node:22-alpine',
    defaultTimeoutMs: 1000,
    maxTimeoutMs: 5000,
    maxOutputChars: 1000,
    dockerExec: async (binary, args) => {
      if (args[0] === 'ps') return { ok: true, stdout: '', stderr: '', code: 0 };
      if (args[0] === 'rm') return { ok: false, stdout: '', stderr: 'permission denied', code: 1 };
      return { ok: true, stdout: 'ok\n', stderr: '', code: 0 };
    },
  });
  const result = await tool.invokeResult?.({ command: 'echo ok' });
  assert.equal(result.status, 'error');
  assert.match(result.content, /删除容器失败/);
});

test('注册表拒绝同时启用沙箱与进程内命令后端', () => {
  assert.throws(
    () => createToolRegistry({ workspaceRoot: 'C:\\work' }, {
      includeExecCommand: true,
      sandbox: { image: 'node:22-alpine' },
    }),
    /互斥/,
  );
});

test('沙箱后端注册为 exec_command，并带结果处理器', () => {
  const registry = createToolRegistry({ workspaceRoot: 'C:\\work' }, {
    includeExecCommand: false,
    sandbox: { image: 'node:22-alpine' },
  });
  assert.deepEqual(registry.names().includes('exec_command'), true);
  assert.match(registry.get('exec_command').description, /Docker 容器/);
  assert.equal(typeof registry.getProcessor('exec_command').compact, 'function');
});

test('inspectDocker 分别报告「连不上」与「没有镜像」', async () => {
  const offline = await inspectDocker({
    image: 'node:22-alpine',
    dockerExec: async () => ({ ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 }),
  });
  assert.equal(offline.ok, false);
  assert.match(offline.reason, /无法连接 Docker/);

  const noImage = await inspectDocker({
    image: 'node:22-alpine',
    dockerExec: async (binary, args) => (args[0] === 'info'
      ? { ok: true, stdout: '29.8.1\n', stderr: '', code: 0 }
      : { ok: true, stdout: 'postgres:17-alpine\n', stderr: '', code: 0 }),
  });
  assert.equal(noImage.ok, false);
  assert.match(noImage.reason, /docker pull node:22-alpine/);
  assert.deepEqual(noImage.available, ['postgres:17-alpine']);
});

/** 有 Docker 与镜像时才跑真实隔离验证；否则跳过并说明原因 */
async function dockerReady(image) {
  const report = await inspectDocker({ image, dockerExec: spawnDocker });
  return report.ok ? report : { ok: false, reason: report.reason };
}

const IMAGE = process.env.AGENT_DOCKER_IMAGE || 'node:22-alpine';

test('真实沙箱：工作区可写、根只读、无网络、外部文件不可见', async (t) => {
  const ready = await dockerReady(IMAGE);
  if (!ready.ok) {
    t.skip(`跳过真实沙箱验证：${ready.reason}`);
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), 'agent-harness-sandbox-'));
  const tool = createDockerCommandTool({
    workspaceRoot: workspace,
    image: IMAGE,
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 120_000,
    maxOutputChars: 8000,
    dockerBinary: process.env.AGENT_DOCKER_BINARY || 'docker',
  });
  try {
    const write = await tool.invokeResult({ command: 'echo hello > inside.txt && cat inside.txt' });
    assert.equal(write.status, 'success', write.content);
    assert.equal((await readFile(join(workspace, 'inside.txt'), 'utf8')).trim(), 'hello');
    assert.match(write.content, /网络已关闭/);

    const network = await tool.invokeResult({
      command: 'wget -T 3 -q -O- http://example.com || echo NETWORK_BLOCKED',
    });
    assert.match(network.content, /NETWORK_BLOCKED/, '容器内必须无法访问外网');

    const readOnly = await tool.invokeResult({ command: 'echo x > /root.txt || echo ROOT_READONLY' });
    assert.match(readOnly.content, /ROOT_READONLY/, '根文件系统必须只读');

    // 宿主文件不可见的两种证据：工作区只被挂到 /workspace；容器根目录里没有宿主内容
    const mounts = await tool.invokeResult({ command: 'grep -c " /workspace " /proc/mounts' });
    assert.match(mounts.content, /1/, '工作区应恰好挂载一次');
    assert.equal(mounts.content.includes('/workspace:'), false);

    // 宿主文件不可见：容器根目录是镜像自己的根，工作区只挂在 /workspace
    const rootListing = await tool.invokeResult({ command: 'ls / | sort | tr "\\n" " "' });
    assert.match(rootListing.content, /workspace/);
    assert.equal(/node_modules|package\.json|aurora\.js/.test(rootListing.content), false,
      '容器根目录不应出现宿主仓库内容');
  } finally {
    // 清理本次验证可能残留的容器，再删除临时目录
    await spawnDocker(process.env.AGENT_DOCKER_BINARY || 'docker',
      ['ps', '-aq', '--filter', 'label=agent-harness.sandbox=1']);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('真实沙箱：超时后容器被删除', async (t) => {
  const ready = await dockerReady(IMAGE);
  if (!ready.ok) {
    t.skip(`跳过真实沙箱验证：${ready.reason}`);
    return;
  }
  const workspace = await mkdtemp(join(tmpdir(), 'agent-harness-sandbox-'));
  const binary = process.env.AGENT_DOCKER_BINARY || 'docker';
  const tool = createDockerCommandTool({
    workspaceRoot: workspace,
    image: IMAGE,
    defaultTimeoutMs: 2000,
    maxTimeoutMs: 2000,
    maxOutputChars: 2000,
    dockerBinary: binary,
  });
  try {
    const result = await tool.invokeResult({ command: 'sleep 30' });
    assert.equal(result.status, 'error', result.content);
    const listed = await spawnDocker(binary, ['ps', '-q', '--filter', 'label=agent-harness.sandbox=1']);
    assert.equal(listed.stdout.trim(), '', `超时后不应留下容器: ${listed.stdout}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
