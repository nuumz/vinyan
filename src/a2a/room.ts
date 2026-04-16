/**
 * A2A Room Manager — cross-instance scoped communication channels.
 *
 * Rooms replace broadcast-only peer communication with targeted multicast:
 * messages with a `room_id` are sent only to room members, not all peers.
 * Messages without `room_id` remain broadcast (backward compatible).
 *
 * All state is in-memory (consistent with PeerTrustManager, IntentManager,
 * NegotiationManager). Message history uses a ring buffer capped at
 * `maxMessageHistory` per room.
 *
 * Source of truth: R3 plan in ~/.claude/plans/greedy-napping-beacon.md
 * Related: docs/research/ai-agent-team-landscape-2026.md §Matrix transparency
 */
import type { EventBus, VinyanBusEvents } from '../core/bus.ts';

// ── Types ─────────────────────────────────────────────────────────────

export type RoomType = 'coordination' | 'knowledge' | 'broadcast' | 'delegation';
export type RoomState = 'active' | 'archived';
export type RoomAction = 'create' | 'join' | 'leave' | 'archive';

export interface RoomMetadata {
  room_id: string;
  name: string;
  topic?: string;
  room_type: RoomType;
  creator_instance_id: string;
  created_at: number;
  state: RoomState;
}

export interface RoomMember {
  instance_id: string;
  joined_at: number;
  peer_url: string;
}

export interface RoomMessage {
  message_id: string;
  room_id: string;
  sender_instance_id: string;
  timestamp: number;
  ecp_message_type: string;
  summary: string;
}

export interface ECPRoomUpdate {
  action: RoomAction;
  room: RoomMetadata;
  member?: RoomMember;
}

export interface RoomManagerConfig {
  instanceId: string;
  bus?: EventBus<VinyanBusEvents>;
  maxRooms?: number;
  maxMessageHistory?: number;
}

// ── Room Manager ──────────────────────────────────────────────────────

const DEFAULT_MAX_ROOMS = 50;
const DEFAULT_MAX_MESSAGE_HISTORY = 1000;

function genRoomId(): string {
  return `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function genMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RoomManager {
  private readonly instanceId: string;
  private readonly bus?: EventBus<VinyanBusEvents>;
  private readonly maxRooms: number;
  private readonly maxMessageHistory: number;

  private readonly rooms = new Map<string, RoomMetadata>();
  private readonly members = new Map<string, Map<string, RoomMember>>(); // roomId → instanceId → member
  private readonly messages = new Map<string, RoomMessage[]>(); // roomId → ring buffer

  constructor(config: RoomManagerConfig) {
    this.instanceId = config.instanceId;
    this.bus = config.bus;
    this.maxRooms = config.maxRooms ?? DEFAULT_MAX_ROOMS;
    this.maxMessageHistory = config.maxMessageHistory ?? DEFAULT_MAX_MESSAGE_HISTORY;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  createRoom(name: string, roomType: RoomType, topic?: string, peerUrl = ''): RoomMetadata | null {
    const activeRooms = Array.from(this.rooms.values()).filter((r) => r.state === 'active');
    if (activeRooms.length >= this.maxRooms) return null;

    const room: RoomMetadata = {
      room_id: genRoomId(),
      name,
      topic,
      room_type: roomType,
      creator_instance_id: this.instanceId,
      created_at: Date.now(),
      state: 'active',
    };
    this.rooms.set(room.room_id, room);
    this.members.set(room.room_id, new Map());
    this.messages.set(room.room_id, []);

    const selfMember: RoomMember = {
      instance_id: this.instanceId,
      joined_at: Date.now(),
      peer_url: peerUrl,
    };
    this.members.get(room.room_id)?.set(this.instanceId, selfMember);

    this.bus?.emit('a2a:roomCreated', {
      roomId: room.room_id,
      name,
      roomType,
      creatorInstanceId: this.instanceId,
    });
    return room;
  }

  joinRoom(roomId: string, peerUrl = ''): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== 'active') return false;

    const memberMap = this.members.get(roomId);
    if (!memberMap) return false;
    if (memberMap.has(this.instanceId)) return true; // already a member

    memberMap.set(this.instanceId, {
      instance_id: this.instanceId,
      joined_at: Date.now(),
      peer_url: peerUrl,
    });
    this.bus?.emit('a2a:roomJoined', { roomId, instanceId: this.instanceId, peerUrl });
    return true;
  }

  leaveRoom(roomId: string): boolean {
    const memberMap = this.members.get(roomId);
    if (!memberMap?.has(this.instanceId)) return false;

    memberMap.delete(this.instanceId);
    this.bus?.emit('a2a:roomLeft', { roomId, instanceId: this.instanceId });
    return true;
  }

  archiveRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== 'active') return false;
    if (room.creator_instance_id !== this.instanceId) return false;

    room.state = 'archived';
    this.bus?.emit('a2a:roomArchived', { roomId });
    return true;
  }

  // ── Remote updates (from A2A peers) ─────────────────────────────────

  handleRemoteRoomUpdate(_peerId: string, update: ECPRoomUpdate): void {
    switch (update.action) {
      case 'create': {
        if (this.rooms.has(update.room.room_id)) return;
        this.rooms.set(update.room.room_id, { ...update.room });
        this.members.set(update.room.room_id, new Map());
        this.messages.set(update.room.room_id, []);
        if (update.member) {
          this.members.get(update.room.room_id)?.set(update.member.instance_id, { ...update.member });
        }
        break;
      }
      case 'join': {
        const room = this.rooms.get(update.room.room_id);
        if (!room || room.state !== 'active') return;
        if (update.member) {
          const memberMap = this.members.get(update.room.room_id);
          memberMap?.set(update.member.instance_id, { ...update.member });
        }
        break;
      }
      case 'leave': {
        if (update.member) {
          this.members.get(update.room.room_id)?.delete(update.member.instance_id);
        }
        break;
      }
      case 'archive': {
        const room = this.rooms.get(update.room.room_id);
        if (room) room.state = 'archived';
        break;
      }
    }
  }

  // ── Message history ─────────────────────────────────────────────────

  recordMessage(roomId: string, senderInstanceId: string, ecpMessageType: string, summary: string): void {
    const msgs = this.messages.get(roomId);
    if (!msgs) return;
    const message: RoomMessage = {
      message_id: genMessageId(),
      room_id: roomId,
      sender_instance_id: senderInstanceId,
      timestamp: Date.now(),
      ecp_message_type: ecpMessageType,
      summary,
    };
    msgs.push(message);
    if (msgs.length > this.maxMessageHistory) {
      msgs.splice(0, msgs.length - this.maxMessageHistory);
    }
    this.bus?.emit('a2a:roomMessage', {
      roomId,
      senderId: senderInstanceId,
      messageType: ecpMessageType,
      summary,
    });
  }

  // ── Queries ─────────────────────────────────────────────────────────

  getRoom(roomId: string): RoomMetadata | undefined {
    return this.rooms.get(roomId);
  }

  getRooms(filter?: { roomType?: RoomType; state?: RoomState }): RoomMetadata[] {
    let results = Array.from(this.rooms.values());
    if (filter?.roomType) results = results.filter((r) => r.room_type === filter.roomType);
    if (filter?.state) results = results.filter((r) => r.state === filter.state);
    return results;
  }

  getRoomMessages(roomId: string, limit?: number): RoomMessage[] {
    const msgs = this.messages.get(roomId);
    if (!msgs) return [];
    if (limit && limit < msgs.length) return msgs.slice(-limit);
    return [...msgs];
  }

  getMemberPeerUrls(roomId: string): string[] {
    const memberMap = this.members.get(roomId);
    if (!memberMap) return [];
    const urls: string[] = [];
    for (const [instanceId, member] of memberMap) {
      if (instanceId !== this.instanceId && member.peer_url) {
        urls.push(member.peer_url);
      }
    }
    return urls;
  }

  getMembers(roomId: string): RoomMember[] {
    const memberMap = this.members.get(roomId);
    if (!memberMap) return [];
    return Array.from(memberMap.values());
  }

  isRoomMember(roomId: string, instanceId?: string): boolean {
    const memberMap = this.members.get(roomId);
    return memberMap?.has(instanceId ?? this.instanceId) === true;
  }

  get roomCount(): number {
    return Array.from(this.rooms.values()).filter((r) => r.state === 'active').length;
  }
}
