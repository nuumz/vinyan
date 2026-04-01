/**
 * CLI commands for pattern export/import — cross-project transfer (PH4.6).
 *
 * vinyan patterns export --workspace <path> [--output <file>]
 * vinyan patterns import --workspace <path> --file <file> [--similarity <threshold>]
 *
 * Source of truth: design/implementation-plan.md §PH4.6
 */
import { join } from "path";
import { readFileSync, writeFileSync } from "fs";
import { VinyanDB } from "../db/vinyan-db.ts";
import { PatternStore } from "../db/pattern-store.ts";
import {
  exportPatterns,
  importPatterns,
  type AbstractPatternExport,
} from "../evolution/pattern-abstraction.ts";
import { loadConfig } from "../config/loader.ts";

export async function runPatternsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "export") {
    await handleExport(args.slice(1));
  } else if (subcommand === "import") {
    await handleImport(args.slice(1));
  } else {
    console.error("Usage: vinyan patterns <export|import>");
    console.error("  export --workspace <path> [--output <file>]");
    console.error("  import --workspace <path> --file <file> [--similarity <threshold>]");
    process.exit(1);
  }
}

async function handleExport(args: string[]): Promise<void> {
  const workspace = getArg(args, "--workspace") ?? process.cwd();
  const outputFile = getArg(args, "--output") ?? "vinyan-patterns.json";

  let db: VinyanDB;
  try {
    db = new VinyanDB(join(workspace, ".vinyan", "vinyan.db"));
  } catch (err) {
    console.error(`Cannot open database at ${workspace}/.vinyan/vinyan.db`);
    process.exit(1);
    return;
  }

  const patternStore = new PatternStore(db.getDb());
  const patterns = patternStore.findActive(0.01);

  const projectId = workspace.split("/").pop() ?? "unknown";
  const exported = exportPatterns(patterns, projectId);

  writeFileSync(outputFile, JSON.stringify(exported, null, 2));
  console.log(`Exported ${exported.patterns.length} abstract patterns (from ${patterns.length} source) to ${outputFile}`);

  db.close();
}

async function handleImport(args: string[]): Promise<void> {
  const workspace = getArg(args, "--workspace") ?? process.cwd();
  const inputFile = getArg(args, "--file");
  const similarity = parseFloat(getArg(args, "--similarity") ?? "0.5");

  if (!inputFile) {
    console.error("--file is required for import");
    process.exit(1);
    return;
  }

  let db: VinyanDB;
  try {
    db = new VinyanDB(join(workspace, ".vinyan", "vinyan.db"));
  } catch {
    console.error(`Cannot open database at ${workspace}/.vinyan/vinyan.db`);
    process.exit(1);
    return;
  }

  let exported: AbstractPatternExport;
  try {
    const raw = readFileSync(inputFile, "utf-8");
    exported = JSON.parse(raw) as AbstractPatternExport;
  } catch {
    console.error(`Cannot read patterns file: ${inputFile}`);
    db.close();
    process.exit(1);
    return;
  }

  // Detect target project's framework/language markers from config
  const targetMarkers = detectProjectMarkers(workspace);
  const targetProjectId = workspace.split("/").pop() ?? "unknown";

  const patternStore = new PatternStore(db.getDb());
  const imported = importPatterns(exported, targetProjectId, targetMarkers, similarity);

  for (const pattern of imported) {
    patternStore.insert(pattern);
  }

  console.log(`Imported ${imported.length} patterns (${exported.patterns.length} in source, similarity threshold: ${similarity})`);
  console.log("All imported patterns enter probation with 50% reduced confidence.");

  db.close();
}

function detectProjectMarkers(workspace: string): { frameworks: string[]; languages: string[] } {
  const frameworks: string[] = [];
  const languages: string[] = [];

  try {
    const config = loadConfig(workspace);
    // Use config hints if available
  } catch {
    // No config — detect from package.json or similar
  }

  // Detect from package.json
  try {
    const pkgRaw = readFileSync(join(workspace, "package.json"), "utf-8");
    const pkg = JSON.parse(pkgRaw);
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

    if (allDeps.react) frameworks.push("react");
    if (allDeps.next) frameworks.push("next");
    if (allDeps.express) frameworks.push("express");
    if (allDeps.fastify) frameworks.push("fastify");
    if (allDeps.zod) frameworks.push("zod");
    if (allDeps.prisma || allDeps["@prisma/client"]) frameworks.push("prisma");
    if (allDeps.vue) frameworks.push("vue");
    if (allDeps.svelte) frameworks.push("svelte");

    if (allDeps.typescript || allDeps["@types/node"]) languages.push("typescript");
    languages.push("javascript"); // package.json implies JS ecosystem
  } catch {
    // No package.json
  }

  // Detect from pyproject.toml / requirements.txt
  try {
    readFileSync(join(workspace, "pyproject.toml"), "utf-8");
    languages.push("python");
  } catch {}
  try {
    readFileSync(join(workspace, "requirements.txt"), "utf-8");
    languages.push("python");
  } catch {}

  return { frameworks, languages };
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
