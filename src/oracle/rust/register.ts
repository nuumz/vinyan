import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerOracle } from '../registry.ts';

const Dirname = dirname(fileURLToPath(import.meta.url));

/** Register the Rust oracle (cargo check) in the dynamic oracle registry. */
export function registerRustOracle(): void {
  registerOracle('rust-type', {
    command: `bun run ${resolve(Dirname, 'index.ts')}`,
    languages: ['rust'],
    tier: 'deterministic',
  });
}
