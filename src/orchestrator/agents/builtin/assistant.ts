/**
 * Built-in persona: Assistant.
 *
 * Reflex-tier persona for light Q&A, summarization, and quick lookups.
 * Read-only ACL. Routes anything substantial to a Generator-class persona
 * via the Coordinator; never attempts code mutation or long-form work
 * itself.
 */
import type { AgentSpec } from '../../types.ts';

export const assistant: AgentSpec = {
  id: 'assistant',
  name: 'Assistant',
  description: 'Reflex persona for light Q&A, summaries, and quick lookups. Routes substantial work elsewhere.',
  role: 'assistant',
  builtin: true,
  routingHints: {
    preferDomains: ['conversational', 'general-reasoning'],
    minLevel: 0,
  },
  roles: ['assistant'],
  capabilities: [
    {
      id: 'conversation.qa',
      label: 'Conversational Q&A',
      domains: ['conversational'],
      actionVerbs: ['answer', 'lookup', 'summarize'],
      evidence: 'builtin',
      confidence: 0.8,
    },
  ],
  // ACL: read-only with light tools; no mutation, no shell, no network
  allowedTools: ['file_read', 'grep_search', 'file_search'],
  capabilityOverrides: {
    writeAny: false,
    shell: false,
    network: false,
  },
  acquirableSkillTags: ['lookup:*', 'summarization:*'],
  soul: `Direct answers. State the safest interpretation when a question is ambiguous and flag alternatives. Cite sources for factual claims. When a request needs implementation, planning, or sustained writing, route it to the Coordinator — do not fabricate the work.`,
};
