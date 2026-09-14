/**
 * 工具注册表 —— 工具的登记处 + 结果处理器的路由表
 *
 * 设计要点（直接对应 min-cursor 里留下的技术债）：
 *   min-cursor 用 `if (toolName === 'xxx')` 在两个文件里各硬编码了一遍结果处理逻辑，
 *   于是「新增一个工具」要改 3 处，而 MCP 动态加载的工具只能走通用兜底。
 *
 *   这里从第一天就做成注册表：
 *     - 工具自带 compact（给模型看的截断版）和 summarize（给终端看的一行摘要）
 *     - 路由层只做 `getProcessor(name) ?? GENERIC_PROCESSOR`
 *     - 加多少工具都不用碰路由代码
 */

/** 没有声明处理器的工具走这里 */
const GENERIC_PROCESSOR = {
  compact: (result) => (result.length > 4000 ? `${result.slice(0, 4000)}\n... (输出已截断)` : result),
  summarize: (result) => (result.length > 60 ? `${result.slice(0, 60)}...` : result),
};

export class ToolRegistry {
  /** @type {Map<string, {name: string, description: string, schema: object, invoke: Function}>} */
  #tools = new Map();
  /** @type {Map<string, {compact: Function, summarize: Function}>} */
  #processors = new Map();

  /**
   * 注册一个工具
   * @param {{name: string, description: string, schema: object, invoke: Function}} tool
   * @param {{compact?: Function, summarize?: Function}} [processors]
   */
  register(tool, { compact, summarize } = {}) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.invoke !== 'function') {
      throw new TypeError('工具必须提供 name 和 invoke');
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具重名: ${tool.name}`);
    }

    this.#tools.set(tool.name, tool);

    if (compact || summarize) {
      this.#processors.set(tool.name, {
        compact: compact ?? GENERIC_PROCESSOR.compact,
        summarize: summarize ?? GENERIC_PROCESSOR.summarize,
      });
    }

    return this;
  }

  has(name) {
    return this.#tools.has(name);
  }

  get(name) {
    return this.#tools.get(name);
  }

  /** 供模型 bindTools / 生成 JSON Schema 用 */
  list() {
    return [...this.#tools.values()];
  }

  names() {
    return [...this.#tools.keys()];
  }

  /** 路由：有专属处理器就用，没有就兜底 */
  getProcessor(name) {
    return this.#processors.get(name) ?? GENERIC_PROCESSOR;
  }

  /**
   * 调用工具 —— 永不抛错
   *
   * Agent 的核心约定：工具失败必须以文本形式回到模型手里，
   * 模型才能看到原因并换一条路。任何 throw 都会打断 ReAct 循环。
   *
   * @returns {Promise<string>} 工具结果或错误说明
   */
  async invoke(name, rawArgs) {
    const tool = this.#tools.get(name);

    if (!tool) {
      return `工具 "${name}" 不存在。可用工具: ${this.names().join(', ')}`;
    }

    const parsed = tool.schema.safeParse(rawArgs ?? {});

    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return `工具 "${name}" 参数不合法: ${issues}`;
    }

    try {
      const result = await tool.invoke(parsed.data);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return `工具 "${name}" 执行出错: ${err?.message || err}`;
    }
  }
}
