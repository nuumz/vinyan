/**
 * FleetRegistry — unified read API over WorkerStore, OraclePeerStore, and
 * LocalOracleProfileStore.
 *
 * Every phase of the core loop can ask the same question ("who is trusted
 * right now?") without touching individual stores. Read-only at this step —
 * no phase wires it into a decision yet; routing still flows through
 * WorkerSelector/gate.ts directly until Step 4.
 *
 * Trust weighting:
 *   active    → 1.0   (gate decisions use verdict at full strength)
 *   probation → 0.3   (informational; still counted but downweighted)
 *   demoted   → 0.0   (excluded from routing; kept for re-enrollment path)
 *   retired   → 0.0   (excluded permanently)
 */

import type { AgentProfileKind, AgentProfileStatus } from './agent-profile.ts';
import type { LocalOracleProfileStore } from '../../db/local-oracle-profile-store.ts';
import type { OracleProfileStore } from '../../db/oracle-profile-store.ts';
import type { WorkerStore } from '../../db/worker-store.ts';
import type { WorkerProfile } from '../types.ts';
import type { OracleProfile } from '../instance-coordinator.ts';
import type { LocalOracleProfile } from './local-oracle-gates.ts';

export interface FleetRegistryDeps {
  workerStore?: WorkerStore;
  oraclePeerStore?: OracleProfileStore;
  localOracleProfileStore?: LocalOracleProfileStore;
}

export interface TrustedProfile {
  kind: AgentProfileKind;
  id: string;
  status: AgentProfileStatus;
  weight: number;
}

export class FleetRegistry {
  constructor(private readonly deps: FleetRegistryDeps) {}

  /** Profiles considered trustworthy enough to contribute — active + probation. */
  listTrusted(kind: AgentProfileKind): TrustedProfile[] {
    switch (kind) {
      case 'worker':
        return this.listTrustedWorkers();
      case 'oracle-peer':
        return this.listTrustedOraclePeers();
      case 'oracle-local':
        return this.listTrustedLocalOracles();
    }
  }

  /** Map a profile to its routing/voting weight. */
  weightFor(kind: AgentProfileKind, id: string): number {
    const status = this.statusFor(kind, id);
    return weightForStatus(status);
  }

  statusFor(kind: AgentProfileKind, id: string): AgentProfileStatus | null {
    switch (kind) {
      case 'worker': {
        const p = this.deps.workerStore?.findById(id);
        return p?.status ?? null;
      }
      case 'oracle-peer': {
        const p = this.deps.oraclePeerStore?.getProfileById(id);
        return p?.status ?? null;
      }
      case 'oracle-local': {
        const p = this.deps.localOracleProfileStore?.findById(id);
        return p?.status ?? null;
      }
    }
  }

  /** Active-only capability view for planning. Returns worker profiles whose
   * status contributes to routing (active only; probation is informational
   * for the plan phase). */
  getActiveWorkers(): WorkerProfile[] {
    return this.deps.workerStore?.findActive() ?? [];
  }

  getActiveOraclePeers(): OracleProfile[] {
    return this.deps.oraclePeerStore?.findByStatus('active') ?? [];
  }

  getActiveLocalOracles(): LocalOracleProfile[] {
    return this.deps.localOracleProfileStore?.findActive() ?? [];
  }

  private listTrustedWorkers(): TrustedProfile[] {
    const store = this.deps.workerStore;
    if (!store) return [];
    const out: TrustedProfile[] = [];
    for (const p of store.findByStatus('active')) {
      out.push({ kind: 'worker', id: p.id, status: 'active', weight: 1.0 });
    }
    for (const p of store.findByStatus('probation')) {
      out.push({ kind: 'worker', id: p.id, status: 'probation', weight: 0.3 });
    }
    return out;
  }

  private listTrustedOraclePeers(): TrustedProfile[] {
    const store = this.deps.oraclePeerStore;
    if (!store) return [];
    const out: TrustedProfile[] = [];
    for (const p of store.findByStatus('active')) {
      out.push({ kind: 'oracle-peer', id: p.id, status: 'active', weight: 1.0 });
    }
    for (const p of store.findByStatus('probation')) {
      out.push({ kind: 'oracle-peer', id: p.id, status: 'probation', weight: 0.3 });
    }
    return out;
  }

  private listTrustedLocalOracles(): TrustedProfile[] {
    const store = this.deps.localOracleProfileStore;
    if (!store) return [];
    const out: TrustedProfile[] = [];
    for (const p of store.findByStatus('active')) {
      out.push({ kind: 'oracle-local', id: p.id, status: 'active', weight: 1.0 });
    }
    for (const p of store.findByStatus('probation')) {
      out.push({ kind: 'oracle-local', id: p.id, status: 'probation', weight: 0.3 });
    }
    return out;
  }
}

export function weightForStatus(status: AgentProfileStatus | null): number {
  switch (status) {
    case 'active':
      return 1.0;
    case 'probation':
      return 0.3;
    case 'demoted':
    case 'retired':
    case null:
      return 0;
  }
}
