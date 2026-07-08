import { isAbstention, type OracleResponse, type OracleVerdict } from '../../src/core/types.ts';

/**
 * Narrow an OracleResponse to an OracleVerdict for tests that exercise the
 * verdict path. Throws (failing the test) when the oracle abstained.
 */
export function asVerdict(response: OracleResponse): OracleVerdict {
  if (isAbstention(response)) {
    throw new Error(`Expected an oracle verdict but got abstention: ${response.reason} (${response.oracleName})`);
  }
  return response;
}
