import OpenAI from 'openai';

/** SDK 自带的重试次数上限；再高也只是拖长一次运行的耗时 */
const MAX_RETRIES_LIMIT = 5;

/**
 * OpenAI 兼容的 Chat Completions 是传输协议，不承担 Agent 循环。
 * 不假定兼容服务也实现了 Responses API 或所有可选参数。
 *
 * 重试放在这一层，而不是放在工具层：工具可能有副作用，自动重试等于重复执行，
 * 而模型请求是幂等的 —— 同一个请求重发一次没有额外后果。
 * 重试交给 SDK：它按指数退避，并尊重服务端返回的 Retry-After。
 */
export function createOpenAICompatibleModel({ apiKey, baseURL, model, client, maxRetries = 0 } = {}) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('缺少 MODEL_NAME（模型名称）');
  }
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) {
    throw new Error('缺少 MODEL_API_KEY 或 OPENAI_API_KEY');
  }
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_LIMIT) {
    throw new RangeError(`maxRetries 必须是 0 到 ${MAX_RETRIES_LIMIT} 之间的整数`);
  }

  const sdk = client ?? new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxRetries,
  });

  return {
    maxRetries,
    async complete({ messages, tools, signal }) {
      let response;
      try {
        response = await sdk.chat.completions.create({
          model,
          messages,
          ...(tools?.length ? { tools } : {}),
        }, { signal });
      } catch (err) {
        // 重试已经用完仍然失败：给出可判断的说明，而不是把 SDK 的原始错误直接抛给上层
        if (signal?.aborted) throw err;
        const status = err?.status ? `HTTP ${err.status} ` : '';
        const attempts = maxRetries > 0 ? `（已重试 ${maxRetries} 次）` : '';
        throw new Error(`模型请求失败 ${status}${attempts}: ${err?.message ?? err}`);
      }
      const choice = response.choices?.[0];
      if (!choice?.message) {
        throw new Error('模型响应缺少 message');
      }
      if (choice.finish_reason === 'length') {
        throw new Error('模型响应达到输出长度上限，可能包含不完整的工具参数');
      }
      return {
        message: choice.message,
        finishReason: choice.finish_reason,
        usage: response.usage ?? null,
      };
    },
  };
}
