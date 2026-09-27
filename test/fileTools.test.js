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
  test('结构化结果区分成功、拒绝、I/O 错误和截断，同时保留文本接口', async () => {
    const tools = registry({ maxOutputChars: 5 });
    await writeFile(join(root, 'long.txt'), 'abcdefghijk', 'utf8');

    const success = await tools.invokeResult('write_file', { filePath: 'new.txt', content: 'ok' });
    assert.equal(success.status, 'success');
    assert.equal(success.truncated, false);
    assert.match(success.content, /已创建文件/);

    const rejected = await tools.invokeResult('write_file', { filePath: 'nul.txt', content: 'a\0b' });
    assert.equal(rejected.status, 'rejected');
    assert.match(rejected.content, /NUL/);
    assert.equal((await tools.invokeResult('write_file', { filePath: 'new.txt', content: 'again' })).status,
      'rejected');

    const invalid = await tools.invokeResult('read_file', {});
    assert.equal(invalid.status, 'rejected');
    assert.equal(invalid.code, 'invalid_arguments');

    const missing = await tools.invokeResult('read_file', { filePath: 'missing.txt' });
    assert.equal(missing.status, 'error');
    assert.match(missing.content, /读取文件失败/);

    const partial = await tools.invokeResult('read_file', { filePath: 'long.txt' });
    assert.equal(partial.status, 'truncated');
    assert.equal(partial.truncated, true);
    assert.equal(await tools.invoke('read_file', { filePath: 'long.txt' }), partial.content);
  });

  test('注册内置工具，参数错误返回文本', async () => {
    const tools = registry();
    assert.deepEqual(tools.names(), [
      'exec_command',
      'read_file',
      'list_directory',
      'search_files',
      'apply_patch',
      'write_file',
    ]);
    assert.match(await tools.invoke('read_file', {}), /参数不合法/);
    assert.match(await tools.invoke('search_files', {}), /参数不合法/);
    assert.match(await tools.invoke('apply_patch', { filePath: 'x' }), /参数不合法/);
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

  test('search_files 递归返回路径和位置，并支持大小写选项', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'alpha.js'), 'const value = "Needle";\n// Needle again\n', 'utf8');
    await writeFile(join(root, 'src', 'beta.js'), 'const value = "needle";\n', 'utf8');
    const tools = registry({ maxOutputChars: 1_000 });

    const exact = await tools.invoke('search_files', { query: 'Needle', path: 'src' });
    assert.match(exact, /src\/alpha\.js:1:16/);
    assert.match(exact, /src\/alpha\.js:2:4/);
    assert.doesNotMatch(exact, /beta\.js:/);

    const insensitive = await tools.invoke('search_files', {
      query: 'needle', path: 'src', caseSensitive: false,
    });
    assert.match(insensitive, /alpha\.js/);
    assert.match(insensitive, /beta\.js/);
    assert.match(insensitive, /找到 3 处匹配/);
  });

  test('search_files 跳过依赖、二进制和超大文件，并限制结果与越界路径', async () => {
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'visible.txt'), 'hit hit hit', 'utf8');
    await writeFile(join(root, 'node_modules', 'hidden.txt'), 'hit', 'utf8');
    await writeFile(join(root, '.git', 'config'), 'hit', 'utf8');
    await writeFile(join(root, 'binary.bin'), Buffer.from([104, 105, 116, 0]));
    await writeFile(join(root, 'large.txt'), 'hit'.repeat(20), 'utf8');
    const tools = registry({ maxOutputChars: 1_000, maxSearchFileBytes: 20 });

    const out = await tools.invoke('search_files', { query: 'hit', maxResults: 2 });
    assert.match(out, /visible\.txt/);
    assert.doesNotMatch(out, /hidden\.txt/);
    assert.doesNotMatch(out, /binary\.bin:/);
    assert.match(out, /找到 2 处匹配/);
    assert.match(out, /结果已达到/);
    assert.match(await tools.invoke('search_files', { query: 'hit', path: '../outside' }), /越出工作区/);
    assert.match(await tools.invoke('search_files', { query: 'a\nb' }), /参数不合法/);
  });

  test('apply_patch 原子执行多项精确替换', async () => {
    await writeFile(join(root, 'code.js'), 'const left = 1;\nconst right = 2;\n', 'utf8');
    const tools = registry();
    const out = await tools.invoke('apply_patch', {
      filePath: 'code.js',
      edits: [
        { oldText: 'left = 1', newText: 'left = 10' },
        { oldText: 'right = 2', newText: 'right = 20' },
      ],
    });
    assert.match(out, /已修改文件/);
    assert.match(out, /2 处替换/);
    assert.equal(await readFile(join(root, 'code.js'), 'utf8'), 'const left = 10;\nconst right = 20;\n');
  });

  test('apply_patch 拒绝歧义和失败项，不留下部分修改', async () => {
    await writeFile(join(root, 'repeat.txt'), 'same\nsame\n', 'utf8');
    const tools = registry();
    assert.match(await tools.invoke('apply_patch', {
      filePath: 'repeat.txt', edits: [{ oldText: 'same', newText: 'changed' }],
    }), /出现 2 次/);
    assert.equal(await readFile(join(root, 'repeat.txt'), 'utf8'), 'same\nsame\n');

    assert.match(await tools.invoke('apply_patch', {
      filePath: 'repeat.txt',
      edits: [
        { oldText: 'same', newText: 'changed', replaceAll: true },
        { oldText: 'missing', newText: 'value' },
      ],
    }), /旧文本未找到/);
    assert.equal(await readFile(join(root, 'repeat.txt'), 'utf8'), 'same\nsame\n');

    assert.match(await tools.invoke('apply_patch', {
      filePath: 'repeat.txt', edits: [{ oldText: 'same', newText: 'changed', replaceAll: true }],
    }), /2 处替换/);
    assert.equal(await readFile(join(root, 'repeat.txt'), 'utf8'), 'changed\nchanged\n');
  });

  test('apply_patch 拒绝不存在、二进制、越界和过大的结果', async () => {
    await writeFile(join(root, 'binary.bin'), Buffer.from([1, 0, 2]));
    await writeFile(join(root, 'large.txt'), `${'a'.repeat(99)}z`, 'utf8');
    const tools = registry();
    assert.match(await tools.invoke('apply_patch', {
      filePath: 'missing.txt', edits: [{ oldText: 'a', newText: 'b' }],
    }), /修改文件失败/);
    assert.match(await tools.invoke('apply_patch', {
      filePath: 'binary.bin', edits: [{ oldText: 'a', newText: 'b' }],
    }), /二进制/);
    assert.match(await tools.invoke('apply_patch', {
      filePath: '../outside/secret.txt', edits: [{ oldText: 'a', newText: 'b' }],
    }), /越出工作区/);
    assert.match(await tools.invoke('apply_patch', {
      filePath: 'large.txt', edits: [{ oldText: 'z', newText: 'abcdefghij' }],
    }), /修改后内容超过/);
    assert.equal(await readFile(join(root, 'large.txt'), 'utf8'), `${'a'.repeat(99)}z`);
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
    assert.match(await tools.invoke('search_files', { path: 'escape', query: 'secret' }), /符号链接越出工作区/);
    assert.match(await tools.invoke('apply_patch', {
      filePath: 'escape/secret.txt', edits: [{ oldText: 'secret', newText: 'bad' }],
    }), /符号链接越出工作区/);
    assert.match(await tools.invoke('write_file', { filePath: 'escape/new.txt', content: 'bad' }), /符号链接越出工作区/);
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
  });
});
