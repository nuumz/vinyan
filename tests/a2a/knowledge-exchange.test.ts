/**
 * Knowledge Exchange Manager tests — Phase E2.
 */
import { describe, expect, test } from 'bun:test';
import { KnowledgeExchangeManager, type KnowledgeOffer } from '../../src/a2a/knowledge-exchange.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import type { AbstractPattern } from '../../src/evolution/pattern-abstraction.ts';
import type { ExtractedPattern, TaskFingerprint } from '../../src/orchestrator/types.ts';

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makePattern(overrides: Partial<ExtractedPattern> = {}): ExtractedPattern {
  return {
    id: 'pat-001',
    type: 'anti-pattern',
    description: 'test pattern',
    frequency: 5,
    confidence: 0.75,
    taskTypeSignature: 'modify::ts::small',
    approach: 'refactor imports',
    sourceTraceIds: ['trace-1'],
    createdAt: Date.now(),
    decayWeight: 1.0,
    ...overrides,
  };
}

function makeAbstractPattern(overrides: Partial<AbstractPattern> = {}): AbstractPattern {
  return {
    fingerprint: {
      actionVerb: 'modify',
      fileExtensions: ['ts'],
      blastRadiusBucket: 'small',
      frameworkMarkers: [],
    },
    approach: 'refactor imports',
    qualityRange: { min: 0.6, max: 0.8 },
    confidence: 0.75,
    sourceProjectId: 'proj-remote',
    sourcePatternIds: ['pat-remote-001'],
    applicabilityConditions: {
      frameworkMarkers: [],
      languageMarkers: ['typescript'],
      complexityRange: ['small'],
    },
    type: 'anti-pattern',
    description: 'test abstract pattern',
    exportedAt: Date.now(),
    ...overrides,
  };
}

// Target markers use raw file extensions to match fingerprint.fileExtensions
const targetMarkers = { frameworks: [], languages: ['ts'] };

describe('KnowledgeExchangeManager — evaluateOffer', () => {
  test('accepts patterns with sufficient similarity', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    const offer: KnowledgeOffer = {
      cycleId: 'cycle-001',
      instanceId: 'inst-remote',
      patterns: [
        {
          id: 'pat-001',
          type: 'anti-pattern',
          fingerprint: {
            actionVerb: 'modify',
            fileExtensions: ['ts'],
            blastRadiusBucket: 'small',
            frameworkMarkers: [],
          },
          confidence: 0.75,
          portability: 'universal',
        },
      ],
    };

    const result = mgr.evaluateOffer(offer);
    expect(result.acceptedPatternIds).toContain('pat-001');
    expect(result.rejectedPatternIds).toHaveLength(0);
  });

  test('rejects project-specific patterns', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    const offer: KnowledgeOffer = {
      cycleId: 'cycle-001',
      instanceId: 'inst-remote',
      patterns: [
        {
          id: 'pat-002',
          type: 'success-pattern',
          fingerprint: {
            actionVerb: 'modify',
            fileExtensions: ['py'],
            blastRadiusBucket: 'small',
          },
          confidence: 0.9,
          portability: 'project-specific',
        },
      ],
    };

    const result = mgr.evaluateOffer(offer);
    expect(result.rejectedPatternIds).toContain('pat-002');
    expect(result.acceptedPatternIds).toHaveLength(0);
  });

  test('rejects patterns with low similarity', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers: { frameworks: ['react'], languages: ['typescript'] },
    });

    const offer: KnowledgeOffer = {
      cycleId: 'cycle-001',
      instanceId: 'inst-remote',
      patterns: [
        {
          id: 'pat-003',
          type: 'anti-pattern',
          fingerprint: {
            actionVerb: 'modify',
            fileExtensions: ['py'],
            blastRadiusBucket: 'large',
            frameworkMarkers: ['django'],
          },
          confidence: 0.8,
          portability: 'framework-specific',
        },
      ],
    };

    const result = mgr.evaluateOffer(offer);
    expect(result.rejectedPatternIds).toContain('pat-003');
  });
});

describe('KnowledgeExchangeManager — importPatterns', () => {
  test('imports patterns with 50% confidence reduction', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    const abstract = makeAbstractPattern({ confidence: 0.8 });
    const imported = mgr.importPatterns({ patterns: [abstract] }, 'peer-remote');

    expect(imported).toHaveLength(1);
    expect(imported[0]!.confidence).toBe(0.4); // 0.80 * 0.5
    expect(imported[0]!.description).toContain('[imported]');
  });

  test('emits a2a:knowledgeImported bus event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:knowledgeImported', (e) => events.push(e));

    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    const abstract = makeAbstractPattern();
    mgr.importPatterns({ patterns: [abstract] }, 'peer-remote');

    expect(events).toHaveLength(1);
    expect(events[0].peerId).toBe('peer-remote');
    expect(events[0].patternsImported).toBe(1);
  });

  test('empty transfer emits no event', () => {
    const bus = makeBus();
    const events: any[] = [];
    bus.on('a2a:knowledgeImported', (e) => events.push(e));

    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    mgr.importPatterns({ patterns: [] }, 'peer-remote');
    expect(events).toHaveLength(0);
  });
});

describe('KnowledgeExchangeManager — lifecycle', () => {
  test('start subscribes to sleep:cycleComplete', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    mgr.start();
    // Should not throw — handler is active
    bus.emit('sleep:cycleComplete', {
      cycleId: 'c1',
      patternsFound: 3,
      rulesGenerated: 1,
      skillsCreated: 0,
      rulesPromoted: 0,
    });
    mgr.stop();
  });

  test('stop unsubscribes', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    mgr.start();
    mgr.stop();
    // No error after stop
    bus.emit('sleep:cycleComplete', {
      cycleId: 'c1',
      patternsFound: 0,
      rulesGenerated: 0,
      skillsCreated: 0,
      rulesPromoted: 0,
    });
  });
});
