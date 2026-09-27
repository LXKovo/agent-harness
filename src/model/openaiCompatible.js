import OpenAI from 'openai';

/**
 * OpenAI 兼容的 Chat Completions 是传输协议，不承担 Agent 循环。
 * 不假定兼容服务也实现了 Responses API 或所有可选参数。
 */
export function createOpenAICompatibleModel({ apiKey, baseURL, model, client } = {}) {
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('缺少 MODEL_NAME（模型名称）');
  }
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) {
    throw new Error('缺少 MODEL_API_KEY 或 OPENAI_API_KEY');
  }

  const sdk = client ?? new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    maxRetries: 0,
  });

  return {
    async complete({ messages, tools, signal }) {
      const response = await sdk.chat.completions.create({
        model,
        messages,
        ...(tools?.length ? { tools } : {}),
      }, { signal });
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
