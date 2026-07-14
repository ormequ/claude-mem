// FORK-OWNED: opt-out switch for the tree-sitter smart_* MCP tools.
// CLAUDE_MEM_SMART_TOOLS=false|0 removes them from MCP registration and
// drops the smart-explore skill (which is built on them) from the default
// skill set. Default is enabled — upstream parity.
export const SMART_TOOL_NAMES: ReadonlySet<string> = new Set([
  'smart_search',
  'smart_unfold',
  'smart_outline',
]);

export function smartToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CLAUDE_MEM_SMART_TOOLS?.trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}
