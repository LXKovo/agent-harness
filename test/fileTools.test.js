import { beforeEach, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createToolRegistry } from '../src/tools/index.js';

let fixture;
let root;
let outside;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'agent-harness-files-'));
  root = join(fixture, 'workspace');
  outside = join(fixture, 'outside');
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  assert.equal(resolve(dirname(fixture)), resolve(tmpdir()));
  await rm(fixture, { recursive: true, force: true });
});

const registry = (overrides = {}) => createToolRegistry({
  workspaceRoot: root,
  maxOutputChars: 100,
  maxWriteChars: 100,
  ...overrides,
});

describe('文件工具', () => {
  test('注册三个文件工具，参数错误返回文本', async () => {
    const tools = registry();
    assert.deepEqual(tools.names(), ['exec_command', 'read_file', 'list_directory', 'write_file']);
    assert.match(await tools.invoke('read_file', {}), /参数不合法/);
    assert.match(await tools.invoke('write_file', { filePath: 'x' }), /参数不合法/);
  });

  test('read_file 读取文本，并报告不存在的文件', async () => {
    await writeFile(join(root, 'hello.txt'), '你好\nworld', 'utf8');
    const tools = registry();
    assert.match(await tools.invoke('read_file', { filePath: 'hello.txt' }), /你好\nworld/);
    assert.match(await tools.invoke('read_file', { filePath: 'missing.txt' }), /读取文件失败/);
  });

  test('read_file 截断长内容，拒绝二进制文件和越界路径', async () => {
    await writeFile(join(root, 'long.txt'), 'abcdefghijk', 'utf8');
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0xff]));
    const tools = registry({ maxOutputChars: 5 });
    const out = await tools.invoke('read_file', { filePath: 'long.txt' });
    assert.match(out, /abcde/);
    assert.doesNotMatch(out, /fghij/);
    assert.match(out, /已截断/);
    assert.match(await tools.invoke('read_file', { filePath: 'binary.bin' }), /不支持二进制/);
    assert.match(await tools.invoke('read_file', { filePath: 'invalid.txt' }), /不是有效的 UTF-8/);
    assert.match(await tools.invoke('read_file', { filePath: '../outside/secret.txt' }), /越出工作区/);
  });

  test('list_directory 只列直接子项，过长时截断', async () => {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'hello.txt'), 'ok');
    await writeFile(join(root, 'nested', 'hidden.txt'), 'ok');
    const tools = registry();
    const out = await tools.invoke('list_directory', {});
    assert.match(out, /目录\s+nested/);
    assert.match(out, /文件\s+hello\.txt/);
    assert.doesNotMatch(out, /hidden\.txt/);
    assert.match(await registry({ maxOutputChars: 3 }).invoke('list_directory', {}), /已截断/);
    assert.match(await tools.invoke('list_directory', { path: 'missing' }), /列出目录失败/);
  });

  test('write_file 默认拒绝覆盖，明确允许时替换文件', async () => {
    const tools = registry();
    assert.match(await tools.invoke('write_file', { filePath: 'note.txt', content: 'first' }), /已创建文件/);
    assert.match(await tools.invoke('write_file', { filePath: 'note.txt', content: 'second' }), /写入文件失败/);
    assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'first');
    assert.match(await tools.invoke('write_file', { filePath: 'note.txt', content: 'second', overwrite: true }), /已覆盖文件/);
    assert.equal(await readFile(join(root, 'note.txt'), 'utf8'), 'second');
  });

  test('write_file 限制内容大小、拒绝越界和不存在的父目录', async () => {
    const tools = registry({ maxWriteChars: 5 });
    assert.match(await tools.invoke('write_file', { filePath: 'large.txt', content: '123456' }), /参数不合法/);
    assert.match(await tools.invoke('write_file', { filePath: '../outside/x.txt', content: 'ok' }), /越出工作区/);
    assert.match(await tools.invoke('write_file', { filePath: 'missing/x.txt', content: 'ok' }), /写入文件失败/);
    assert.match(await tools.invoke('write_file', { filePath: 'nul.txt', content: 'a\0b' }), /NUL/);
  });

  test('文件工具拒绝通过目录链接访问工作区外', async (t) => {
    await writeFile(join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) {
        t.skip(`当前环境无法创建目录链接: ${err.code}`);
        return;
      }
      throw err;
    }

    const tools = registry();
    assert.match(await tools.invoke('read_file', { filePath: 'escape/secret.txt' }), /符号链接越出工作区/);
    assert.match(await tools.invoke('list_directory', { path: 'escape' }), /符号链接越出工作区/);
    assert.match(await tools.invoke('write_file', { filePath: 'escape/new.txt', content: 'bad' }), /符号链接越出工作区/);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
  });
});
