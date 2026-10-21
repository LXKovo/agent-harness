/**
 * 从 fetch 响应里读取最多 maxBytes 个字节。
 *
 * 先流式读再截断，不把整个响应交给 arrayBuffer：网页可能几百 MB，
 * 一次抓取不应该按对方的大小分配内存。
 */
export async function readBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { buffer: Buffer.alloc(0), bytes: 0, truncated: false };

  const chunks = [];
  let bytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        bytes += remaining;
        truncated = true;
        await reader.cancel();
        break;
      }

      chunks.push(Buffer.from(value));
      bytes += value.byteLength;
      if (bytes >= maxBytes) {
        // 已经到上限；再读一次判断是否还有内容，避免把刚好等于上限的响应误标为截断。
        const next = await reader.read();
        if (!next.done && next.value?.byteLength) truncated = true;
        break;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已取消的流可能已经释放锁；这里不再掩盖原始读取错误。
    }
  }

  return { buffer: Buffer.concat(chunks), bytes, truncated };
}

export function contentTypeOf(response) {
  return (response.headers?.get?.('content-type') ?? '').trim();
}

export function isAllowedContentType(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (!type) return true;
  return type.startsWith('text/')
    || type === 'application/json'
    || type === 'application/ld+json'
    || type === 'application/xml'
    || type === 'application/xhtml+xml'
    || type === 'application/rss+xml'
    || type === 'application/atom+xml';
}

export function isHtmlContentType(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

export function decodeText(buffer, contentType) {
  const charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(String(contentType ?? ''))?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * 把 fetch 的「fetch failed」补上底层原因（ENOTFOUND、ECONNRESET 等）。
 *
 * Node 的 fetch 只把 cause 藏在 error.cause 里；只回传顶层消息会让模型
 * 无法区分「域名不存在」「连接被重置」和「证书问题」，只能盲目重试。
 */
export function describeFetchError(error) {
  const message = String(error?.message ?? error ?? '未知错误').slice(0, 300);
  const cause = error?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : (typeof error?.code === 'string' ? error.code : '');
  const causeMessage = typeof cause?.message === 'string' && cause.message !== message
    ? cause.message.slice(0, 300)
    : '';
  const detail = [code, causeMessage].filter(Boolean).join(': ');
  return detail ? `${message}（${detail}）` : message;
}
