import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCheckpointStore } from '../src/agent/checkpointStore.js';
import { episodeFromResult, relevantEpisodes, renderEpisodes } from '../src/agent/episodicMemory.js';

const projectRoot = resolve(import.meta.dirname, '..');

test('情景记忆按任务相关性选择，并限制注入长度', () => {
  const episodes = [
    { id: 1, sessionId: 'old', createdAt: '2026-10-01',
      task: '确认 retryCount 的配置位置', answer: 'retryCount 位于 src/settings.js',
      toolNames: ['read_file'] },
    { id: 2, sessionId: 'unrelated', createdAt: '2026-10-02',
      task: '修复图片尺寸', answer: '修改 assets/logo.svg', toolNames: ['apply_patch'] },
  ];
  const selected = relevantEpisodes(episodes, '将 retryCount 改为 3');
  assert.deepEqual(selected.map((item) => item.sessionId), ['old']);
  const context = renderEpisodes(selected);
  assert.match(context, /来源会话 old/);
  assert.match(context, /未经独立核实/);
  assert.doesNotMatch(context, /unrelated/);
  assert.equal(renderEpisodes(selected, 100), '');
  assert.equal(episodeFromResult('失败任务', { status: 'model_error' }), null);
});

test('已有 checkpoint 数据库可升级并保存带项目的会话', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-memory-migration-'));
  const path = join(root, 'sessions.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, task TEXT NOT NULL,
    allow_shell INTEGER NOT NULL, status TEXT NOT NULL, answer TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  legacy.close();
  const store = createCheckpointStore(path);
  try {
    store.create({ id: 'migrated', workspace: root, task: '任务', projectId: 'demo',
      allowShell: false, state: { phase: 'ready', turnsUsed: 0, pendingCallId: null,
        messages: [{ role: 'system', content: 's' }, { role: 'user', content: '任务' }] } });
    assert.equal(store.load('migrated').projectId, 'demo');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('跨会话情景记忆影响文件结果，并与其他项目隔离', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-harness-memory-'));
  const dbPath = join(root, 'sessions.sqlite');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const task = body.messages.findLast((message) => message.role === 'user').content;
    const hasToolResult = body.messages.some((message) => message.role === 'tool');
    let message;
    if (task === '确认 retryCount 的配置位置') {
      message = hasToolResult
        ? { role: 'assistant', content: '已读取并确认：retryCount 位于 src/settings.js。' }
        : { role: 'assistant', content: null, tool_calls: [{
          id: 'read-1', type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ filePath: 'src/settings.js' }) },
        }] };
    } else {
      const remembered = body.messages.some((item) => item.role === 'user'
        && item.content.includes('来源会话 source') && item.content.includes('src/settings.js'));
      message = hasToolResult
        ? { role: 'assistant', content: '操作结束。' }
        : { role: 'assistant', content: null, tool_calls: [{
          id: 'patch-1', type: 'function', function: {
            name: 'apply_patch', arguments: JSON.stringify({
              filePath: remembered ? 'src/settings.js' : 'src/other.js',
              edits: [{ oldText: 'retryCount: 2', newText: 'retryCount: 3' }],
            }),
          },
        }] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-memory', object: 'chat.completion', created: 1, model: 'fake-model',
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    }));
  });

  async function workspace(name) {
    const path = join(root, name);
    await mkdir(join(path, 'src'), { recursive: true });
    await writeFile(join(path, 'src', 'settings.js'), 'retryCount: 2\n', 'utf8');
    return path;
  }

  async function runCli(args, port) {
    const child = spawn(process.execPath, ['src/index.js', ...args], {
      cwd: projectRoot, windowsHide: true,
      env: { ...process.env, MODEL_NAME: 'fake-model', MODEL_API_KEY: 'test-key',
        MODEL_BASE_URL: `http://127.0.0.1:${port}/v1` },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    const exitCode = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    });
    assert.equal(exitCode, 0, stderr);
    return stderr;
  }

  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const source = await workspace('source');
    const withMemory = await workspace('with-memory');
    const withoutMemory = await workspace('without-memory');
    await runCli(['--workspace', source, '--project', 'demo', '--session', 'source',
      '--checkpoint-db', dbPath, '确认 retryCount 的配置位置'], port);
    const secondRunLog = await runCli(['--workspace', withMemory, '--project', 'demo',
      '--checkpoint-db', dbPath, '将 retryCount 改为 3'], port);
    await runCli(['--workspace', withoutMemory, '--project', 'other', '--session', 'without-memory',
      '--checkpoint-db', dbPath, '将 retryCount 改为 3'], port);

    assert.equal(await readFile(join(withMemory, 'src', 'settings.js'), 'utf8'), 'retryCount: 3\n');
    assert.equal(await readFile(join(withoutMemory, 'src', 'settings.js'), 'utf8'), 'retryCount: 2\n');
    const store = createCheckpointStore(dbPath);
    try {
      const episodes = store.recentEpisodes('demo');
      assert.equal(episodes.length, 2);
      assert.match(episodes[0].sessionId, /^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
      assert.match(secondRunLog, new RegExp(`会话 ${episodes[0].sessionId}`));
      assert.deepEqual(episodes[1].toolNames, ['read_file']);
      assert.match(episodes[1].answer, /src\/settings\.js/);
      assert.equal(store.recentEpisodes('other').length, 1);
      assert.equal(store.load(episodes[0].sessionId).projectId, 'demo');
    } finally {
      store.close();
    }
  } finally {
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
