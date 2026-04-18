/**
 * vinyan config — view and validate configuration.
 *
 * Subcommands:
 *   show      Print effective config (vinyan.json + defaults) as JSON
 *   validate  Validate vinyan.json and report errors
 *   path      Print path to vinyan.json
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config/index.ts';

export async function runConfigCommand(argv: string[]): Promise<void> {
  const sub = argv[0] ?? 'show';
  const workspace = parseSingleFlag(argv, '--workspace') ?? process.cwd();

  switch (sub) {
    case 'show': {
      try {
        const config = loadConfig(workspace);
        console.log(JSON.stringify(config, null, 2));
      } catch (err) {
        console.error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case 'validate': {
      const configPath = join(workspace, 'vinyan.json');
      if (!existsSync(configPath)) {
        console.error(`✗ vinyan.json not found at ${configPath}`);
        console.error('  Run `vinyan init` to create one.');
        process.exit(1);
      }

      try {
        loadConfig(workspace);
        console.log('✓ vinyan.json is valid');
      } catch (err) {
        console.error('✗ vinyan.json validation failed:\n');
        if (err instanceof Error) {
          // Zod errors have readable messages
          console.error(err.message);
        }
        process.exit(1);
      }
      break;
    }

    case 'path': {
      console.log(join(workspace, 'vinyan.json'));
      break;
    }

    default:
      console.error('Usage: vinyan config <show|validate|path> [--workspace <path>]');
      process.exit(1);
  }
}

function parseSingleFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
