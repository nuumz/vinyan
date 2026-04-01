import { spawnSync } from 'child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODING_TASKS } from './tasks.ts';

const W = './tests/experiment/fixtures/workspace';
let cp = 0;
let cf = 0;
let ip = 0;
let iff = 0;
const errs: string[] = [];

for (const t of CODING_TASKS) {
  for (const k of ['correct', 'incorrect'] as const) {
    const m = k === 'correct' ? t.correctMutation : t.incorrectMutation;
    const d = mkdtempSync(join(tmpdir(), 'vt-'));
    try {
      cpSync(W, d, { recursive: true });
      writeFileSync(join(d, m.file), m.content);
      const r = spawnSync('npx', ['tsc', '--noEmit', '-p', join(d, 'tsconfig.json')], {
        timeout: 15000,
        encoding: 'utf8',
      });
      if (k === 'correct') {
        if (r.status !== 0) {
          cf++;
          errs.push(t.id + ' correct FAIL: ' + (r.stdout ?? '').split('\n')[0]);
        } else {
          cp++;
        }
      } else {
        if (r.status !== 0) {
          iff++;
        } else {
          ip++;
          errs.push(t.id + ' incorrect COMPILED OK');
        }
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
  process.stdout.write('.');
}

console.log('');
console.log('Correct: ' + cp + ' pass, ' + cf + ' fail');
console.log('Incorrect: ' + iff + ' fail(good), ' + ip + ' pass(BAD)');
errs.forEach((e) => console.log('ERR:', e));
process.exit(errs.length);
