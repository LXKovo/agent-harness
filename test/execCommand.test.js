import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createExecCommandTool, resolveTimeoutMs } from '../src/tools/execCommand.js';
import { config } from '../src/config.js';

const tool = createExecCommandTool({
  ...config,
  defaultTimeoutMs: 3000,
  maxTimeoutMs: 10_000,
  maxOutputChars: 2000,
});

describe('resolveTimeoutMs（超时封顶）', () => {
  const limits = { defaultTimeoutMs: 1000, maxTimeoutMs: 5000 };

  test('未指定时用默认值', () => {
    assert.equal(resolveTimeoutMs(undefined, limits), 1000);
  });

  test('合理值原样通过', () => {
    assert.equal(resolveTimeoutMs(2000, limits), 2000);
  });

  test('超过上限时被截到上限——模型不能给自己开无限超时', () => {
    assert.equal(resolveTimeoutMs(999_999, limits), 5000);
  });
});

describe('exec_command', () => {
  test('成功命令：返回 stdout 给模型', async () => {
    const out = await tool.invoke({ command: 'echo hello-harness' });
    assert.match(out, /命令执行成功/);
    assert.match(out, /hello-harness/);
  });

  test('非 0 退出码：不抛错，而是把失败原因返回', async () => {
    const out = await tool.invoke({ command: 'exit 3' });
    assert.match(out, /命令执行失败/);
    assert.match(out, /3/);
  });

  test('stderr 同样被捕获', async () => {
    const out = await tool.invoke({ command: 'echo oops 1>&2' });
    assert.match(out, /stderr/);
    assert.match(out, /oops/);
  });

  test('管道与 && 可用（说明确实跑在 shell 里）', async () => {
    const out = await tool.invoke({ command: 'echo abc | tr a-z A-Z' });
    assert.match(out, /ABC/);
  });

  test('超时：杀掉进程并迅速返回，而不是干等', async () => {
    const started = Date.now();
    const out = await tool.invoke({ command: 'sleep 30', timeoutMs: 300 });
    const elapsed = Date.now() - started;

    assert.match(out, /超时/);
    assert.match(out, /已终止进程树/);
    assert.ok(elapsed < 5000, `应在超时后迅速返回，实际耗时 ${elapsed}ms`);
  });

  test('cwd 越出工作区：拒绝执行，命令不会跑', async () => {
    const out = await tool.invoke({ command: 'echo should-not-run', cwd: '../../' });
    assert.match(out, /命令未执行/);
    assert.match(out, /越出工作区/);
    assert.doesNotMatch(out, /should-not-run\n/);
  });

  test('cwd 在工作区内：正常生效', async () => {
    const out = await tool.invoke({ command: 'pwd', cwd: 'src' });
    assert.match(out, /命令执行成功/);
    assert.match(out, /src/);
  });

  test('输出超长时被截断，避免撑爆上下文', async () => {
    const out = await tool.invoke({
      command: 'node -e "process.stdout.write(\'x\'.repeat(5000))"',
      timeoutMs: 5000,
    });
    assert.match(out, /已截断/);
  });
});
