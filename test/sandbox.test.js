import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { resolveInWorkspace, isInWorkspace, SandboxError } from '../src/safety/sandbox.js';

const ROOT = process.platform === 'win32' ? 'C:\\work\\project' : '/work/project';
const OUTSIDE_ABS = process.platform === 'win32' ? 'D:\\other\\secret.txt' : '/etc/passwd';

describe('resolveInWorkspace', () => {
  test('接受工作区内的相对路径', () => {
    assert.equal(
      resolveInWorkspace('src/index.js', { root: ROOT }),
      resolve(ROOT, 'src/index.js'),
    );
  });

  test('接受工作区内的绝对路径', () => {
    const target = resolve(ROOT, 'a/b.txt');
    assert.equal(resolveInWorkspace(target, { root: ROOT }), target);
  });

  test('root 本身（"."）是合法的', () => {
    assert.equal(resolveInWorkspace('.', { root: ROOT }), ROOT);
  });

  test('拒绝 ../ 逃逸', () => {
    assert.throws(() => resolveInWorkspace('../outside.txt', { root: ROOT }), SandboxError);
    assert.throws(() => resolveInWorkspace('a/../../outside.txt', { root: ROOT }), SandboxError);
  });

  test('拒绝工作区外的绝对路径', () => {
    assert.throws(() => resolveInWorkspace(OUTSIDE_ABS, { root: ROOT }), SandboxError);
  });

  test('拒绝空路径', () => {
    assert.throws(() => resolveInWorkspace('', { root: ROOT }), SandboxError);
    assert.throws(() => resolveInWorkspace('   ', { root: ROOT }), SandboxError);
  });

  test('拒绝非绝对路径的 root', () => {
    assert.throws(() => resolveInWorkspace('a.txt', { root: 'relative/dir' }), SandboxError);
  });

  test('相对路径以 base 为基准解析', () => {
    const base = resolve(ROOT, 'sub');
    assert.equal(
      resolveInWorkspace('f.txt', { root: ROOT, base }),
      resolve(ROOT, 'sub/f.txt'),
    );
  });

  test('即便 base 在子目录，也不能借它跳出 root', () => {
    const base = resolve(ROOT, 'sub');
    assert.throws(() => resolveInWorkspace('../../x.txt', { root: ROOT, base }), SandboxError);
  });
});

describe('isInWorkspace', () => {
  test('布尔版不抛错，只回答在不在', () => {
    assert.equal(isInWorkspace('src/a.js', { root: ROOT }), true);
    assert.equal(isInWorkspace('../a.js', { root: ROOT }), false);
    assert.equal(isInWorkspace(OUTSIDE_ABS, { root: ROOT }), false);
  });
});
