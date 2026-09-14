/**
 * 超时工具 —— 把「可能永不结束的操作」变成「有限时间内一定返回」
 *
 * 两条使用路径，别混：
 *
 *   1. withTimeout(promise, ms)
 *      适用于「放弃等待就够了」的场景，比如一次 HTTP 请求。
 *      注意它只是「不再等」，被包装的 promise 仍在后台跑。
 *
 *   2. 杀进程树（见 src/tools/execCommand.js 的 killTree）
 *      适用于子进程。Promise.race 对子进程毫无意义——你不再等它，
 *      它照样占着 CPU 和端口。必须真的把它（以及它的子进程）杀掉。
 *
 * 这两点正是「超时」在 Agent 里容易被做错的地方：很多人只做了 1，
 * 结果 Agent 看起来没卡住，机器却在后台跑着一堆僵尸命令。
 */

export class TimeoutError extends Error {
  constructor(message, timeoutMs) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 给任意 Promise 加超时
 *
 * @param {Promise<*>} promise
 * @param {number} timeoutMs
 * @param {object} [opts]
 * @param {string} [opts.message] - 超时时的错误信息
 * @returns {Promise<*>}
 * @throws {TimeoutError}
 */
export function withTimeout(promise, timeoutMs, { message } = {}) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(message || `操作超时 (${timeoutMs}ms)`, timeoutMs)),
      timeoutMs,
    );
  });

  // finally 保证无论谁先完成都会清掉定时器，否则 Node 进程会被它拖住不退出
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
