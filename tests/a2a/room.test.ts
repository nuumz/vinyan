/**
 * A2A RoomManager — behavior tests.
 *
 * Covers room lifecycle (create/join/leave/archive), remote updates,
 * message history ring buffer, membership queries, scoped peer URLs,
 * and bus event emissions.
 */
import { describe, expect, it } from 'bun:test';
import { ECPDataPartSchema, ECPMessageTypeSchema } from '../../src/a2a/ecp-data-part.ts';
import { RoomManager, type RoomMember, type RoomMetadata } from '../../src/a2a/room.ts';
import { createBus } from '../../src/core/bus.ts';

function makeManager(
  overrides: { instanceId?: string; maxRooms?: number; maxMessageHistory?: number; withBus?: boolean } = {},
) {
  const bus = overrides.withBus !== false ? createBus() : undefined;
  return {
    manager: new RoomManager({
      instanceId: overrides.instanceId ?? 'inst-A',
      bus,
      maxRooms: overrides.maxRooms,
      maxMessageHistory: overrides.maxMessageHistory,
    }),
    bus,
  };
}

// ── Room Creation ───────────────────────────────────────────────────

describe('RoomManager — creation', () => {
  it('creates a room with metadata, adds creator as first member, emits event', () => {
    const { manager, bus } = makeManager();
    const events: unknown[] = [];
    bus!.on('a2a:roomCreated', (p) => events.push(p));

    const room = manager.createRoom('ts-verify', 'coordination', 'TypeScript verification');
    expect(room).not.toBeNull();
    expect(room!.name).toBe('ts-verify');
    expect(room!.room_type).toBe('coordination');
    expect(room!.topic).toBe('TypeScript verification');
    expect(room!.creator_instance_id).toBe('inst-A');
    expect(room!.state).toBe('active');
    expect(manager.isRoomMember(room!.room_id)).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('rejects creation at maxRooms limit', () => {
    const { manager } = makeManager({ maxRooms: 2 });
    manager.createRoom('r1', 'coordination');
    manager.createRoom('r2', 'knowledge');
    const third = manager.createRoom('r3', 'broadcast');
    expect(third).toBeNull();
    expect(manager.roomCount).toBe(2);
  });
});

// ── Join / Leave / Archive ──────────────────────────────────────────

describe('RoomManager — join/leave/archive', () => {
  it('joinRoom adds self as member, emits event', () => {
    const { manager, bus } = makeManager();
    const room = manager.createRoom('r1', 'coordination')!;
    const events: unknown[] = [];
    bus!.on('a2a:roomJoined', (p) => events.push(p));

    // Create a second manager to simulate another instance joining
    const { manager: mgr2 } = makeManager({ instanceId: 'inst-B' });
    // First store the room on mgr2 via handleRemoteRoomUpdate
    mgr2.handleRemoteRoomUpdate('inst-A', { action: 'create', room });
    const joined = mgr2.joinRoom(room.room_id, 'http://inst-b:3000');
    expect(joined).toBe(true);
    expect(mgr2.isRoomMember(room.room_id)).toBe(true);
  });

  it('leaveRoom removes self, emits event', () => {
    const { manager, bus } = makeManager();
    const room = manager.createRoom('r1', 'coordination')!;
    const events: unknown[] = [];
    bus!.on('a2a:roomLeft', (p) => events.push(p));

    const left = manager.leaveRoom(room.room_id);
    expect(left).toBe(true);
    expect(manager.isRoomMember(room.room_id)).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('archiveRoom sets state to archived, emits event', () => {
    const { manager, bus } = makeManager();
    const room = manager.createRoom('r1', 'coordination')!;
    const events: unknown[] = [];
    bus!.on('a2a:roomArchived', (p) => events.push(p));

    const archived = manager.archiveRoom(room.room_id);
    expect(archived).toBe(true);
    expect(manager.getRoom(room.room_id)!.state).toBe('archived');
    expect(events).toHaveLength(1);
  });

  it('only creator can archive a room', () => {
    const { manager: creator } = makeManager({ instanceId: 'inst-A' });
    const room = creator.createRoom('r1', 'coordination')!;

    const { manager: nonCreator } = makeManager({ instanceId: 'inst-B' });
    nonCreator.handleRemoteRoomUpdate('inst-A', { action: 'create', room });
    nonCreator.joinRoom(room.room_id);

    expect(nonCreator.archiveRoom(room.room_id)).toBe(false);
    expect(nonCreator.getRoom(room.room_id)!.state).toBe('active');
  });

  it('cannot join an archived room', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('r1', 'coordination')!;
    manager.archiveRoom(room.room_id);
    manager.leaveRoom(room.room_id);
    expect(manager.joinRoom(room.room_id)).toBe(false);
  });
});

// ── Remote Updates ──────────────────────────────────────────────────

describe('RoomManager — remote updates', () => {
  function makeRoom(): RoomMetadata {
    return {
      room_id: 'room-remote-1',
      name: 'remote-room',
      room_type: 'knowledge',
      creator_instance_id: 'inst-X',
      created_at: Date.now(),
      state: 'active',
    };
  }

  function makeMember(instanceId: string): RoomMember {
    return { instance_id: instanceId, joined_at: Date.now(), peer_url: `http://${instanceId}:3000` };
  }

  it('create action stores room metadata', () => {
    const { manager } = makeManager();
    const room = makeRoom();
    manager.handleRemoteRoomUpdate('inst-X', { action: 'create', room, member: makeMember('inst-X') });
    expect(manager.getRoom('room-remote-1')).toBeDefined();
    expect(manager.getMembers('room-remote-1')).toHaveLength(1);
  });

  it('join action adds member to room', () => {
    const { manager } = makeManager();
    const room = makeRoom();
    manager.handleRemoteRoomUpdate('inst-X', { action: 'create', room });
    manager.handleRemoteRoomUpdate('inst-Y', { action: 'join', room, member: makeMember('inst-Y') });
    expect(manager.getMembers('room-remote-1')).toHaveLength(1);
  });

  it('leave action removes member from room', () => {
    const { manager } = makeManager();
    const room = makeRoom();
    manager.handleRemoteRoomUpdate('inst-X', { action: 'create', room, member: makeMember('inst-X') });
    manager.handleRemoteRoomUpdate('inst-X', { action: 'leave', room, member: makeMember('inst-X') });
    expect(manager.getMembers('room-remote-1')).toHaveLength(0);
  });

  it('archive action sets state to archived', () => {
    const { manager } = makeManager();
    const room = makeRoom();
    manager.handleRemoteRoomUpdate('inst-X', { action: 'create', room });
    manager.handleRemoteRoomUpdate('inst-X', { action: 'archive', room });
    expect(manager.getRoom('room-remote-1')!.state).toBe('archived');
  });
});

// ── Message History ─────────────────────────────────────────────────

describe('RoomManager — message history', () => {
  it('recordMessage appends to history, emits event', () => {
    const { manager, bus } = makeManager();
    const room = manager.createRoom('r1', 'coordination')!;
    const events: unknown[] = [];
    bus!.on('a2a:roomMessage', (p) => events.push(p));

    manager.recordMessage(room.room_id, 'inst-B', 'knowledge_transfer', 'shared pattern X');
    const msgs = manager.getRoomMessages(room.room_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.ecp_message_type).toBe('knowledge_transfer');
    expect(events).toHaveLength(1);
  });

  it('ring buffer caps at maxMessageHistory', () => {
    const { manager } = makeManager({ maxMessageHistory: 3 });
    const room = manager.createRoom('r1', 'coordination')!;
    for (let i = 0; i < 5; i++) {
      manager.recordMessage(room.room_id, 'inst-B', 'feedback', `msg-${i}`);
    }
    const msgs = manager.getRoomMessages(room.room_id);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.summary).toBe('msg-2');
    expect(msgs[2]!.summary).toBe('msg-4');
  });

  it('getRoomMessages with limit returns most recent N', () => {
    const { manager } = makeManager();
    const room = manager.createRoom('r1', 'coordination')!;
    for (let i = 0; i < 10; i++) {
      manager.recordMessage(room.room_id, 'inst-B', 'feedback', `msg-${i}`);
    }
    const recent = manager.getRoomMessages(room.room_id, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.summary).toBe('msg-7');
  });
});

// ── Queries ─────────────────────────────────────────────────────────

describe('RoomManager — queries', () => {
  it('getRooms returns all, filterable by type and state', () => {
    const { manager } = makeManager();
    manager.createRoom('r1', 'coordination');
    manager.createRoom('r2', 'knowledge');
    const r3 = manager.createRoom('r3', 'coordination')!;
    manager.archiveRoom(r3.room_id);

    expect(manager.getRooms()).toHaveLength(3);
    expect(manager.getRooms({ roomType: 'coordination' })).toHaveLength(2);
    expect(manager.getRooms({ state: 'active' })).toHaveLength(2);
    expect(manager.getRooms({ roomType: 'coordination', state: 'active' })).toHaveLength(1);
  });

  it('getMemberPeerUrls excludes self, returns peer URLs', () => {
    const { manager } = makeManager({ instanceId: 'inst-A' });
    const room = manager.createRoom('r1', 'coordination', undefined, 'http://inst-a:3000')!;
    // Simulate two remote peers joining
    manager.handleRemoteRoomUpdate('inst-B', {
      action: 'join',
      room: manager.getRoom(room.room_id)!,
      member: { instance_id: 'inst-B', joined_at: Date.now(), peer_url: 'http://inst-b:3000' },
    });
    manager.handleRemoteRoomUpdate('inst-C', {
      action: 'join',
      room: manager.getRoom(room.room_id)!,
      member: { instance_id: 'inst-C', joined_at: Date.now(), peer_url: 'http://inst-c:3000' },
    });

    const urls = manager.getMemberPeerUrls(room.room_id);
    expect(urls).toHaveLength(2);
    expect(urls).toContain('http://inst-b:3000');
    expect(urls).toContain('http://inst-c:3000');
    expect(urls).not.toContain('http://inst-a:3000');
  });

  it('isRoomMember works for self and peers', () => {
    const { manager } = makeManager({ instanceId: 'inst-A' });
    const room = manager.createRoom('r1', 'coordination')!;
    expect(manager.isRoomMember(room.room_id)).toBe(true);
    expect(manager.isRoomMember(room.room_id, 'inst-A')).toBe(true);
    expect(manager.isRoomMember(room.room_id, 'inst-B')).toBe(false);
  });
});

// ── ECP Protocol ────────────────────────────────────────────────────

describe('ECP protocol extension', () => {
  it('room_update is a valid ECP message type', () => {
    const result = ECPMessageTypeSchema.safeParse('room_update');
    expect(result.success).toBe(true);
  });

  it('room_id field is accepted on ECPDataPart', () => {
    const result = ECPDataPartSchema.safeParse({
      ecp_version: 1,
      message_type: 'room_update',
      epistemic_type: 'known',
      confidence: 1.0,
      confidence_reported: true,
      room_id: 'room-123',
      payload: { action: 'create' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.room_id).toBe('room-123');
    }
  });

  it('ECPDataPart without room_id is still valid (backward compatible)', () => {
    const result = ECPDataPartSchema.safeParse({
      ecp_version: 1,
      message_type: 'heartbeat',
      epistemic_type: 'known',
      confidence: 1.0,
      confidence_reported: true,
      payload: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.room_id).toBeUndefined();
    }
  });
});
