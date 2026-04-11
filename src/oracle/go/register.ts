import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { registerOracle } from '../registry.ts';

const Dirname = dirname(fileURLToPath(import.meta.url));

/** Register the Go oracle (go build + go vet) in the dynamic oracle registry. */
export function registerGoOracle(): void {
  registerOracle('go-type', {
    command: `bun run ${resolve(Dirname, 'index.ts')}`,
    languages: ['go'],
    tier: 'deterministic',
  });
}
