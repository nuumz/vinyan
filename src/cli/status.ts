/**
 * CLI status/metrics/rules/skills commands — operational visibility.
 *
 * Loads the Vinyan DB from the workspace and prints formatted summaries.
 */
import { join } from "path";
import { existsSync } from "fs";
import { VinyanDB } from "../db/vinyan-db.ts";
import { TraceStore } from "../db/trace-store.ts";
import { RuleStore } from "../db/rule-store.ts";
import { SkillStore } from "../db/skill-store.ts";
import { PatternStore } from "../db/pattern-store.ts";
import { ShadowStore } from "../db/shadow-store.ts";
import { getSystemMetrics } from "../observability/metrics.ts";

function openDB(workspace: string): VinyanDB | null {
  const dbPath = join(workspace, ".vinyan", "vinyan.db");
  if (!existsSync(dbPath)) {
    console.error(`No Vinyan database found at ${dbPath}`);
    console.error("Run 'vinyan init' first, or specify --workspace.");
    return null;
  }
  return new VinyanDB(dbPath);
}

export async function runStatusCommand(workspace: string): Promise<void> {
  const db = openDB(workspace);
  if (!db) {
    process.exit(1);
    return;
  }

  try {
    const raw = db.getDb();
    const traceStore = new TraceStore(raw);
    const ruleStore = new RuleStore(raw);
    const skillStore = new SkillStore(raw);
    const patternStore = new PatternStore(raw);
    const shadowStore = new ShadowStore(raw);

    const m = getSystemMetrics({
      traceStore,
      ruleStore,
      skillStore,
      patternStore,
      shadowStore,
    });

    console.log("=== Vinyan System Status ===\n");

    console.log("Traces:");
    console.log(`  Total:              ${m.traces.total}`);
    console.log(`  Distinct task types: ${m.traces.distinctTaskTypes}`);
    console.log(`  Success rate:       ${(m.traces.successRate * 100).toFixed(1)}%`);
    console.log(`  Avg quality:        ${m.traces.avgQualityComposite.toFixed(3)}`);

    console.log("\nRules:");
    console.log(`  Active: ${m.rules.active}  Probation: ${m.rules.probation}  Retired: ${m.rules.retired}  Total: ${m.rules.total}`);

    console.log("\nSkills:");
    console.log(`  Active: ${m.skills.active}  Probation: ${m.skills.probation}  Demoted: ${m.skills.demoted}  Total: ${m.skills.total}`);

    console.log("\nPatterns:");
    console.log(`  Total: ${m.patterns.total}  Sleep cycles run: ${m.patterns.sleepCyclesRun}`);

    console.log(`\nShadow queue: ${m.shadow.queueDepth} pending`);

    console.log("\nData gates:");
    console.log(`  Sleep cycle:      ${m.dataGates.sleepCycle ? "READY" : "not ready"}`);
    console.log(`  Skill formation:  ${m.dataGates.skillFormation ? "READY" : "not ready"}`);
    console.log(`  Evolution engine: ${m.dataGates.evolutionEngine ? "READY" : "not ready"}`);
    console.log(`  Fleet routing:    ${m.dataGates.fleetRouting ? "READY" : "not ready"}`);
  } finally {
    db.close();
  }
}

export async function runMetricsCommand(workspace: string): Promise<void> {
  const db = openDB(workspace);
  if (!db) {
    process.exit(1);
    return;
  }

  try {
    const raw = db.getDb();
    const traceStore = new TraceStore(raw);
    const ruleStore = new RuleStore(raw);
    const skillStore = new SkillStore(raw);
    const patternStore = new PatternStore(raw);
    const shadowStore = new ShadowStore(raw);

    const m = getSystemMetrics({
      traceStore,
      ruleStore,
      skillStore,
      patternStore,
      shadowStore,
    });

    console.log(JSON.stringify(m, null, 2));
  } finally {
    db.close();
  }
}

export async function runRulesCommand(workspace: string): Promise<void> {
  const db = openDB(workspace);
  if (!db) {
    process.exit(1);
    return;
  }

  try {
    const raw = db.getDb();
    const ruleStore = new RuleStore(raw);

    const active = ruleStore.findActive();
    const probation = ruleStore.findByStatus("probation");

    console.log(`=== Evolutionary Rules (${active.length} active, ${probation.length} probation) ===\n`);

    for (const rule of [...active, ...probation]) {
      const cond = Object.entries(rule.condition)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.log(`[${rule.status}] ${rule.id}`);
      console.log(`  Action:        ${rule.action}`);
      console.log(`  Condition:     ${cond || "(any)"}`);
      console.log(`  Effectiveness: ${rule.effectiveness.toFixed(3)}`);
      console.log(`  Specificity:   ${rule.specificity}`);
      console.log("");
    }

    if (active.length === 0 && probation.length === 0) {
      console.log("No active or probation rules.");
    }
  } finally {
    db.close();
  }
}

export async function runSkillsCommand(workspace: string): Promise<void> {
  const db = openDB(workspace);
  if (!db) {
    process.exit(1);
    return;
  }

  try {
    const raw = db.getDb();
    const skillStore = new SkillStore(raw);

    const active = skillStore.findActive();
    const probation = skillStore.findByStatus("probation");

    console.log(`=== Cached Skills (${active.length} active, ${probation.length} probation) ===\n`);

    for (const skill of [...active, ...probation]) {
      console.log(`[${skill.status}] ${skill.taskSignature}`);
      console.log(`  Approach:     ${skill.approach.slice(0, 80)}`);
      console.log(`  Success rate: ${(skill.successRate * 100).toFixed(1)}%`);
      console.log(`  Usage count:  ${skill.usageCount}`);
      console.log(`  Verification: ${skill.verificationProfile}`);
      console.log("");
    }

    if (active.length === 0 && probation.length === 0) {
      console.log("No active or probation skills.");
    }
  } finally {
    db.close();
  }
}
