/**
 * lint-oracle — standalone process entry point.
 * Reads HypothesisTuple from stdin, writes OracleVerdict to stdout.
 */
import { verify } from './lint-verifier.ts';

const input = await Bun.stdin.text();
const hypothesis = JSON.parse(input);
const verdict = await verify(hypothesis);
process.stdout.write(`${JSON.stringify(verdict)}\n`);
