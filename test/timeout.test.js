import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, TimeoutError } from '../src/safety/timeout.js';

const never = () => new Promise(() => {});

describe('withTimeout', () => {
  test('操作先完成时，返回它的结果', async () => {
    assert.equal(await withTimeout(Promise.resolve('ok'), 1000), 'ok');
  });

  test('操作先失败时，原样抛出它的错误', async () => {
    const boom = Promise.reject(new Error('底层失败'));
    const err = await withTimeout(boom, 1000).catch((e) => e);
    assert.equal(err.message, '底层失败');
    assert.equal(err.name, 'Error');
  });

  test('操作未完成时抛 TimeoutError', async () => {
    await assert.rejects(() => withTimeout(never(), 30), TimeoutError);
  });

  test('TimeoutError 带上超时毫秒数，便于定位', async () => {
    const err = await withTimeout(never(), 25).catch((e) => e);
    assert.equal(err.name, 'TimeoutError');
    assert.equal(err.timeoutMs, 25);
    assert.match(err.message, /25ms/);
  });

  test('超时后清理定时器，不拖住 Node 进程退出', async () => {
    // 正常完成后立即结束；若定时器未清理，node --test 会因此挂住
    await withTimeout(Promise.resolve(1), 60_000);
    assert.ok(true);
  });
});
