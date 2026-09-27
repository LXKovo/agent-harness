import { SandboxError } from '../safety/sandbox.js';

export function toolResult(status, content, { truncated = false } = {}) {
  return { status, content, truncated };
}

export function toolError(content, error) {
  return toolResult(error instanceof SandboxError ? 'rejected' : 'error', content);
}

// Keep the text-only tool interface for callers while exposing the same operation's status.
export function withToolResult(tool) {
  const invokeResult = tool.invoke;
  return {
    ...tool,
    invokeResult,
    async invoke(...args) {
      return (await invokeResult(...args)).content;
    },
  };
}
