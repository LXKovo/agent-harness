import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
