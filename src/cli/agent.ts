/**
 * CLI: vinyan agent — manage specialist agents.
 *
 * Subcommands:
 *   list              Print all registered agents (built-in + config).
 *   show <id>         Show details for one agent (soul + ACL + hints).
 *   add <id>          Add a new agent to vinyan.json.
 *   remove <id>       Remove an agent from vinyan.json.
 *
 * Writes to `vinyan.json` preserving existing formatting (similar to `init`).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/index.ts';
import { loadAgentRegistry } from '../orchestrator/agents/registry.ts';
import { resolveSoulPath } from '../orchestrator/agents/soul-loader.ts';

export async function runAgentCommand(argv: string[], workspace: string): Promise<void> {
  const sub = argv[0] ?? 'list';

  switch (sub) {
    case 'list':
      return runList(workspace);
    // Phase 2: `inspect` is the primary verb; `show` kept as alias
    case 'inspect':
    case 'show':
      return runShow(argv[1], workspace);
    // Phase 2: `create` is the primary verb; `add` kept as alias
    case 'create':
    case 'add':
      return runAdd(argv.slice(1), workspace);
    case 'remove':
    case 'rm':
      return runRemove(argv[1], workspace);
    default:
      console.error(`Unknown agent subcommand: ${sub}`);
      console.error('Usage: vinyan agent <list|create|inspect|remove> [args]');
      process.exit(1);
  }
}

function runList(workspace: string): void {
  const config = loadConfig(workspace);
  const registry = loadAgentRegistry(workspace, config.agents);
  const agents = registry.listAgents();
  const defaultId = registry.defaultAgent().id;

  console.log(`=== Specialist Agents (${agents.length}) ===\n`);
  for (const a of agents) {
    const tag = a.builtin ? 'built-in' : 'custom';
    const def = a.id === defaultId ? ' ★' : '';
    console.log(`  ${a.id}${def}  [${tag}]`);
    console.log(`    ${a.name}`);
    console.log(`    ${a.description}`);
    if (a.routingHints?.preferDomains) {
      console.log(`    domains: ${a.routingHints.preferDomains.join(', ')}`);
    }
    console.log('');
  }
  console.log('★ = default agent (selected when no --agent flag and classifier unsure)');
}

function runShow(id: string | undefined, workspace: string): void {
  if (!id) {
    console.error('Usage: vinyan agent inspect <id>');
    process.exit(1);
  }
  const config = loadConfig(workspace);
  const registry = loadAgentRegistry(workspace, config.agents);
  const agent = registry.getAgent(id);
  if (!agent) {
    console.error(`Agent '${id}' not found`);
    process.exit(1);
  }

  console.log(`=== Agent: ${agent.id} ===`);
  console.log(`Name:        ${agent.name}`);
  console.log(`Description: ${agent.description}`);
  console.log(`Type:        ${agent.builtin ? 'built-in' : 'custom'}`);
  const soulPath = resolveSoulPath(workspace, agent.id, agent.soulPath);
  console.log(`Soul path:   ${soulPath}${existsSync(soulPath) ? ' (exists)' : ' (built-in, not on disk)'}`);

  if (agent.routingHints) {
    console.log('\nRouting hints:');
    if (agent.routingHints.minLevel !== undefined) console.log(`  min level:  ${agent.routingHints.minLevel}`);
    if (agent.routingHints.preferDomains) console.log(`  domains:    ${agent.routingHints.preferDomains.join(', ')}`);
    if (agent.routingHints.preferExtensions) console.log(`  extensions: ${agent.routingHints.preferExtensions.join(', ')}`);
    if (agent.routingHints.preferFrameworks) console.log(`  frameworks: ${agent.routingHints.preferFrameworks.join(', ')}`);
  }

  if (agent.allowedTools?.length) {
    console.log(`\nAllowed tools (${agent.allowedTools.length}):`);
    for (const t of agent.allowedTools) console.log(`  - ${t}`);
  }

  if (agent.capabilityOverrides) {
    console.log('\nCapability overrides:');
    for (const [k, v] of Object.entries(agent.capabilityOverrides)) {
      console.log(`  ${k}: ${v}`);
    }
  }

  // Phase 2: agent-context summary (episodes, lessons) + skill count
  printAgentContextSummary(workspace, agent.id);
  printAgentSkillCount(workspace, agent.id);

  if (agent.soul) {
    console.log('\n--- Soul (persona) ---');
    console.log(agent.soul);
  }
}

/** Phase 2: read agent_contexts row and print episode/lessons summary. */
function printAgentContextSummary(workspace: string, agentId: string): void {
  try {
    const dbPath = join(workspace, '.vinyan', 'vinyan.db');
    if (!existsSync(dbPath)) return;
    // Lazy import to avoid DB dependency in --help paths
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const { AgentContextStore } = require('../db/agent-context-store.ts') as typeof import('../db/agent-context-store.ts');
    const db = new Database(dbPath);
    try {
      const store = new AgentContextStore(db);
      const ctx = store.findById(agentId);
      if (!ctx) return;
      console.log('\nAgent context:');
      console.log(`  episodes:    ${ctx.memory.episodes.length}`);
      if (ctx.memory.lessonsSummary) {
        const summary = ctx.memory.lessonsSummary.slice(0, 140);
        console.log(`  lessons:     ${summary}${ctx.memory.lessonsSummary.length > 140 ? '…' : ''}`);
      }
      const profCount = Object.keys(ctx.skills.proficiencies).length;
      if (profCount > 0) console.log(`  proficiencies: ${profCount}`);
    } finally {
      db.close();
    }
  } catch {
    /* best-effort — never break inspect */
  }
}

/** Phase 2: count agent-scoped skills in SkillStore. */
function printAgentSkillCount(workspace: string, agentId: string): void {
  try {
    const dbPath = join(workspace, '.vinyan', 'vinyan.db');
    if (!existsSync(dbPath)) return;
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM cached_skills WHERE agent_id = ?`)
        .get(agentId) as { n: number };
      if (row.n > 0) console.log(`  skills:      ${row.n}`);
    } finally {
      db.close();
    }
  } catch {
    /* best-effort */
  }
}

function runAdd(argv: string[], workspace: string): void {
  const id = argv[0];
  if (!id) {
    console.error('Usage: vinyan agent add <id> [--name "Display Name"] [--desc "Description"]');
    process.exit(1);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    console.error(`Invalid agent id: '${id}' (must be kebab-case, starting with a letter)`);
    process.exit(1);
  }

  const config = loadConfig(workspace);
  const registry = loadAgentRegistry(workspace, config.agents);
  if (registry.has(id)) {
    console.error(`Agent '${id}' already exists (use 'show' to inspect)`);
    process.exit(1);
  }

  const name = parseFlag(argv, '--name') ?? id;
  const desc = parseFlag(argv, '--desc') ?? parseFlag(argv, '--description') ?? `Custom agent: ${name}`;

  const configPath = join(workspace, 'vinyan.json');
  if (!existsSync(configPath)) {
    console.error(`No vinyan.json at ${configPath}. Run 'vinyan init' first.`);
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse vinyan.json: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const agents = Array.isArray(json.agents) ? (json.agents as unknown[]) : [];
  agents.push({ id, name, description: desc });
  json.agents = agents;

  writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
  console.log(`Added agent '${id}' to ${configPath}`);
  console.log(`Edit ${join(workspace, '.vinyan', 'souls', `${id}.soul.md`)} to customize the persona.`);
}

function runRemove(id: string | undefined, workspace: string): void {
  if (!id) {
    console.error('Usage: vinyan agent remove <id>');
    process.exit(1);
  }

  const configPath = join(workspace, 'vinyan.json');
  if (!existsSync(configPath)) {
    console.error(`No vinyan.json at ${configPath}`);
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const json: Record<string, unknown> = JSON.parse(raw);
  const agents = Array.isArray(json.agents) ? (json.agents as Array<{ id: string }>) : [];
  const before = agents.length;
  const filtered = agents.filter((a) => a.id !== id);

  if (filtered.length === before) {
    console.error(`Agent '${id}' not found in vinyan.json (built-ins cannot be removed, only overridden)`);
    process.exit(1);
  }

  json.agents = filtered;
  writeFileSync(configPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
  console.log(`Removed agent '${id}' from ${configPath}`);
}

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}
