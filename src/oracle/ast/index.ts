/**
 * ast-oracle — standalone process entry point.
 * Reads HypothesisTuple from stdin, writes OracleVerdict to stdout.
 */
import { verify } from './ast-verifier.ts';

const input = await Bun.stdin.text();
const hypothesis = JSON.parse(input);
const verdict = verify(hypothesis);
process.stdout.write(JSON.stringify(verdict) + '\n');
