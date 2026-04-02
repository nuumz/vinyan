/**
 * Tool manifest — filters available tools by routing level.
 *
 * Phase 6: Agentic Worker Protocol foundation.
 */
import type { RoutingDecision } from '../types.ts';
import { BUILT_IN_TOOLS } from './built-in-tools.ts';
import type { ToolDescriptor } from './tool-interface.ts';

/**
 * Returns tool descriptors available at the given routing level.
 * L0: no tools (reflex — hash-only verify)
 * L1: read-only tools + control tools
 * L2+: all tools including write, shell, delegation
 */
export function manifestFor(routing: RoutingDecision): ToolDescriptor[] {
  if (routing.level === 0) return [];

  const descriptors: ToolDescriptor[] = [];
  for (const tool of BUILT_IN_TOOLS.values()) {
    const desc = tool.descriptor();
    if (desc.minRoutingLevel <= routing.level) {
      descriptors.push(desc);
    }
  }

  return descriptors;
}
