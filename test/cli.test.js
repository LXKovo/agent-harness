import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');

test('CLI 通过本地 OpenAI 兼容接口完成文件任务', { timeout: 15_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-harness-cli-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const message = requests.length === 1
      ? {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'write-1', type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ filePath: 'result.txt', content: 'hello' }) },
        }],
      }
      : { role: 'assistant', content: '文件已写入' };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: `chatcmpl-${requests.length}`, object: 'chat.completion', created: 1, model: 'fake-model',
      choices: [{ index: 0, message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }],
    }));
  });

  try {
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const port = server.address().port;
    const child = spawn(process.execPath, [
      'src/index.js', '--workspace', workspace, '创建 result.txt',
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MODEL_NAME: 'fake-model', MODEL_API_KEY: 'test-key',
        MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`,
      },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolveExit, reject) => {
      child.on('error', reject);
      child.on('close', resolveExit);
    });
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /文件已写入/);
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'hello');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools.some((tool) => tool.function.name === 'exec_command'), false);
    assert.equal(requests[0].tools.some((tool) => tool.function.name === 'search_files'), true);
    assert.equal(requests[0].tools.some((tool) => tool.function.name === 'apply_patch'), true);
    assert.equal(requests[1].messages.at(-1).tool_call_id, 'write-1');
    assert.match(requests[1].messages.at(-1).content, /已创建文件/);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(workspace, { recursive: true, force: true });
  }
});

test('CLI 在另一个进程恢复 SQLite 会话', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-resume-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const dbPath = join(root, 'checkpoints.sqlite');
  const requests = [];
  // 第一次运行：工具执行成功，紧接着的那次模型请求失败。
  // 不能再用「第几个请求失败」判断：模型层现在会重试，同一个请求会被发多次。
  // 也不能让第一次请求就失败 —— 那样工具根本没跑，会话也就没什么可恢复的。
  let failModels = true;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const hasToolResult = requests.at(-1).messages.some((message) => message.role === 'tool');
    if (failModels && hasToolResult) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '模拟模型故障' } }));
      return;
    }
    const message = hasToolResult
      ? { role: 'assistant', content: '恢复完成' }
      : { role: 'assistant', content: null, tool_calls: [{
        id: 'write-1', type: 'function', function: {
          name: 'write_file', arguments: JSON.stringify({ filePath: 'result.txt', content: 'hello' }),
        },
      }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: `chatcmpl-${requests.length}`, object: 'chat.completion', created: 1, model: 'fake-model',
      choices: [{ index: 0, message, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }],
    }));
  });

  async function runCli(args, port) {
    const child = spawn(process.execPath, ['src/index.js', ...args], {
      cwd: projectRoot, windowsHide: true,
      env: { ...process.env, MODEL_NAME: 'fake-model', MODEL_API_KEY: 'test-key',
        // 测试环境关掉重试：否则 500 之后要走退避，测试会变慢且不稳定
        AGENT_MODEL_MAX_RETRIES: '0',
        MODEL_BASE_URL: `http://127.0.0.1:${port}/v1` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    });
    return { exitCode, stdout, stderr };
  }

  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const first = await runCli([
      '--workspace', workspace, '--session', 'demo', '--checkpoint-db', dbPath, '创建文件',
    ], port);
    assert.equal(first.exitCode, 1);
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'hello');
    assert.ok(requests.some((item) => item.messages.some((message) => message.role === 'tool')),
      '第一次运行里工具确实执行过，会话才有恢复意义');
    failModels = false;
    const resumed = await runCli(['--resume', 'demo', '--checkpoint-db', dbPath], port);
    assert.equal(resumed.exitCode, 0, resumed.stderr);
    assert.match(resumed.stdout, /恢复完成/);
    const resumedRequest = requests.at(-1);
    assert.equal(resumedRequest.messages.at(-1).tool_call_id, 'write-1');
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'hello');
  } finally {
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
