/**
 * Tool manifest — filters available tools by routing level.
 *
 * Phase 6: Agentic Worker Protocol foundation.
 * Phase 7e: accepts an optional `extraTools` map so MCP (or any future
 * dynamic tool source) can be surfaced alongside the built-ins without
 * mutating `BUILT_IN_TOOLS`.
 */
import type { RoutingDecision } from '../types.ts';
import { BUILT_IN_TOOLS } from './built-in-tools.ts';
import type { Tool, ToolDescriptor } from './tool-interface.ts';

/**
 * Returns tool descriptors available at the given routing level.
 * L0: no tools (reflex — hash-only verify)
 * L1: read-only tools + control tools
 * L2+: all tools including write, shell, delegation
 *
 * Additional tools (e.g. MCP adapters built at startup) are merged on
 * top of the built-ins. Same routing-level filter applies to both.
 */
export function manifestFor(routing: RoutingDecision, extraTools?: ReadonlyMap<string, Tool>): ToolDescriptor[] {
  if (routing.level === 0) return [];

  const descriptors: ToolDescriptor[] = [];
  for (const tool of BUILT_IN_TOOLS.values()) {
    const desc = tool.descriptor();
    if (desc.minRoutingLevel <= routing.level) {
      descriptors.push(desc);
    }
  }
  if (extraTools) {
    for (const tool of extraTools.values()) {
      const desc = tool.descriptor();
      if (desc.minRoutingLevel <= routing.level) {
        descriptors.push(desc);
      }
    }
  }

  return descriptors;
}
