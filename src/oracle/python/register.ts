import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { registerOracle } from "../registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Register the Python type oracle (pyright) in the dynamic oracle registry. */
export function registerPythonTypeOracle(): void {
  registerOracle("python-type", {
    command: `bun run ${resolve(__dirname, "index.ts")}`,
    languages: ["python"],
    tier: "deterministic",
  });
}
