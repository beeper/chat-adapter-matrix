import type { Logger, StateAdapter } from "chat";
import { MatrixEvent, type IStartClientOpts } from "matrix-js-sdk";
import type { IEvent } from "matrix-js-sdk/lib/models/event.js";
import type {
  IndexedToDeviceBatch,
  ToDeviceBatchWithTxnId,
} from "matrix-js-sdk/lib/models/ToDeviceMessage.js";
import { SyncAccumulator, type ISyncResponse } from "matrix-js-sdk/lib/sync-accumulator.js";
import type { IStateEventWithRoomId } from "matrix-js-sdk/lib/@types/search.js";
import { MemoryStore } from "matrix-js-sdk/lib/store/memory.js";
import type { ISavedSync } from "matrix-js-sdk/lib/store/index.js";

const STORE_VERSION = 1;
const DEFAULT_PERSIST_INTERVAL_MS = 30_000;

type PersistedMeta = {
  filterIds: Record<string, string>;
  lastSavedAt?: string;
  nextBatch?: string;
  nextToDeviceBatchID: number;
  updatedAt: string;
  version: number;
};

type PersistedToDeviceState = {
  batches: IndexedToDeviceBatch[];
};

type PersistedIndex = {
  roomIDs: string[];
};

function normalizeStringRecord(
  value: Record<string, unknown> | undefined
): Record<string, string> {
  if (!value) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[0] === "string" && typeof entry[1] === "string";
    })
  );
}

function normalizeRoomIndex(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.roomIDs)) {
    return [];
  }

  return value.roomIDs.filter((roomID): roomID is string => typeof roomID === "string");
}

function isPersistedMeta(value: unknown): value is PersistedMeta {
  return (
    isRecord(value) &&
    value.version === STORE_VERSION &&
    typeof value.updatedAt === "string" &&
    typeof value.nextToDeviceBatchID === "number"
  );
}

function isSavedSync(value: unknown): value is ISavedSync {
  return (
    isRecord(value) &&
    typeof value.nextBatch === "string" &&
    Array.isArray(value.accountData) &&
    isRecord(value.roomsData)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ChatStateMatrixStore extends MemoryStore {
  private readonly state: StateAdapter;
  private readonly scopeKey: string;
  private readonly logger: Logger;
  private readonly persistIntervalMs: number;
  private readonly snapshotTtlMs?: number;
  private readonly syncAccumulator = new SyncAccumulator();
  private latestSavedSync: ISavedSync | null = null;
  private filterIDs = new Map<string, string>();
  private pendingEventsByRoom = new Map<string, Partial<IEvent>[]>();
  private oobMembersByRoom = new Map<string, IStateEventWithRoomId[]>();
  private persistedToDeviceBatches: IndexedToDeviceBatch[] = [];
  private nextToDeviceBatchID = 0;
  private dirty = false;
  private started = false;
  private newlyCreated = true;
  private lastSavedAt = 0;

  constructor(options: {
    state: StateAdapter;
    scopeKey: string;
    logger: Logger;
    persistIntervalMs?: number;
    snapshotTtlMs?: number;
  }) {
    super();
    this.state = options.state;
    this.scopeKey = options.scopeKey;
    this.logger = options.logger;
    this.persistIntervalMs =
      options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
    this.snapshotTtlMs = options.snapshotTtlMs;
  }

  override async startup(): Promise<void> {
    if (this.started) {
      return;
    }

    const [meta, savedSync, clientOptions, toDevice, oobRoomIDs, pendingRoomIDs] =
      await Promise.all([
        this.state.get<unknown>(this.metaKey),
        this.state.get<unknown>(this.savedSyncKey),
        this.state.get<IStartClientOpts>(this.clientOptionsKey),
        this.state.get<PersistedToDeviceState | IndexedToDeviceBatch[]>(this.toDeviceKey),
        this.state.get<unknown>(this.oobMembersIndexKey),
        this.state.get<unknown>(this.pendingEventsIndexKey),
      ]);

    if (isPersistedMeta(meta)) {
      this.filterIDs = new Map(Object.entries(normalizeStringRecord(meta.filterIds)));
      this.nextToDeviceBatchID = meta.nextToDeviceBatchID;
      this.lastSavedAt = meta.lastSavedAt ? Date.parse(meta.lastSavedAt) || 0 : 0;
      this.newlyCreated = false;
    }

    if (isSavedSync(savedSync)) {
      this.latestSavedSync = savedSync;
      this.syncAccumulator.accumulate({
        next_batch: savedSync.nextBatch,
        rooms: savedSync.roomsData,
        account_data: { events: savedSync.accountData },
      });
      super.setSyncToken(savedSync.nextBatch);
      super.storeAccountDataEvents(
        savedSync.accountData.map((event) => new MatrixEvent(event))
      );
      this.newlyCreated = false;
    }

    if (clientOptions) {
      await super.storeClientOptions(clientOptions);
      this.newlyCreated = false;
    }

    if (Array.isArray(toDevice)) {
      this.persistedToDeviceBatches = toDevice;
      this.newlyCreated = false;
    } else if (isRecord(toDevice) && Array.isArray(toDevice.batches)) {
      this.persistedToDeviceBatches = toDevice.batches;
      this.newlyCreated = false;
    }

    await this.loadIndexedRoomState(oobRoomIDs, pendingRoomIDs);
    this.started = true;
  }

  override async isNewlyCreated(): Promise<boolean> {
    return this.newlyCreated;
  }

  override wantsSave(): boolean {
    if (!this.dirty) {
      return false;
    }

    return Date.now() - this.lastSavedAt >= this.persistIntervalMs;
  }

  override async save(force = false): Promise<void> {
    if (!this.dirty || (!force && !this.wantsSave())) {
      return;
    }

    if (!this.latestSavedSync) {
      this.dirty = false;
      return;
    }

    const nowISO = new Date().toISOString();
    const meta: PersistedMeta = {
      version: STORE_VERSION,
      updatedAt: nowISO,
      lastSavedAt: nowISO,
      nextBatch: this.latestSavedSync.nextBatch,
      filterIds: Object.fromEntries(this.filterIDs),
      nextToDeviceBatchID: this.nextToDeviceBatchID,
    };

    await Promise.all([
      this.state.set(this.savedSyncKey, this.latestSavedSync, this.snapshotTtlMs),
      this.state.set(this.metaKey, meta, this.snapshotTtlMs),
    ]);

    this.lastSavedAt = Date.now();
    this.dirty = false;
  }

  override async getSavedSync(): Promise<ISavedSync | null> {
    if (this.latestSavedSync) {
      return this.latestSavedSync;
    }

    const stored = await this.state.get<unknown>(this.savedSyncKey);
    if (isSavedSync(stored)) {
      this.latestSavedSync = stored;
      return stored;
    }

    return null;
  }

  override async getSavedSyncToken(): Promise<string | null> {
    if (this.latestSavedSync?.nextBatch) {
      return this.latestSavedSync.nextBatch;
    }

    const meta = await this.state.get<unknown>(this.metaKey);
    if (isPersistedMeta(meta) && typeof meta.nextBatch === "string") {
      return meta.nextBatch;
    }

    return null;
  }

  override async setSyncData(syncData: ISyncResponse): Promise<void> {
    this.syncAccumulator.accumulate(syncData);
    const accumulated = this.syncAccumulator.getJSON(true);
    if (!accumulated.nextBatch) {
      return;
    }

    this.latestSavedSync = accumulated;
    super.setSyncToken(accumulated.nextBatch);
    super.storeAccountDataEvents(
      accumulated.accountData.map((event) => new MatrixEvent(event))
    );
    this.dirty = true;
  }

  override async getClientOptions(): Promise<IStartClientOpts | undefined> {
    const existing = await super.getClientOptions();
    if (existing) {
      return existing;
    }

    const stored = await this.state.get<IStartClientOpts>(this.clientOptionsKey);
    if (!stored) {
      return undefined;
    }

    await super.storeClientOptions(stored);
    return stored;
  }

  override async storeClientOptions(options: IStartClientOpts): Promise<void> {
    await super.storeClientOptions(options);
    await this.state.set(this.clientOptionsKey, options, this.snapshotTtlMs);
  }

  override async getOutOfBandMembers(
    roomId: string
  ): Promise<IStateEventWithRoomId[] | null> {
    const cached = this.oobMembersByRoom.get(roomId);
    if (cached) {
      return cached;
    }

    const stored = await this.state.get<IStateEventWithRoomId[] | null>(
      this.oobMembersKey(roomId)
    );
    if (!stored) {
      return null;
    }

    this.oobMembersByRoom.set(roomId, stored);
    return stored;
  }

  override async setOutOfBandMembers(
    roomId: string,
    membershipEvents: IStateEventWithRoomId[]
  ): Promise<void> {
    this.oobMembersByRoom.set(roomId, membershipEvents);
    await Promise.all([
      this.state.set(this.oobMembersKey(roomId), membershipEvents, this.snapshotTtlMs),
      this.persistRoomIndex(this.oobMembersIndexKey, this.oobMembersByRoom),
    ]);
  }

  override async clearOutOfBandMembers(roomId: string): Promise<void> {
    this.oobMembersByRoom.delete(roomId);
    await Promise.all([
      this.state.delete(this.oobMembersKey(roomId)),
      this.persistRoomIndex(this.oobMembersIndexKey, this.oobMembersByRoom),
    ]);
  }

  override async getPendingEvents(roomId: string): Promise<Partial<IEvent>[]> {
    const cached = this.pendingEventsByRoom.get(roomId);
    if (cached) {
      return cached;
    }

    const stored = await this.state.get<Partial<IEvent>[] | null>(
      this.pendingEventsKey(roomId)
    );
    if (!stored) {
      return [];
    }

    this.pendingEventsByRoom.set(roomId, stored);
    return stored;
  }

  override async setPendingEvents(
    roomId: string,
    events: Partial<IEvent>[]
  ): Promise<void> {
    if (events.length === 0) {
      this.pendingEventsByRoom.delete(roomId);
      await Promise.all([
        this.state.delete(this.pendingEventsKey(roomId)),
        this.persistRoomIndex(this.pendingEventsIndexKey, this.pendingEventsByRoom),
      ]);
      return;
    }

    this.pendingEventsByRoom.set(roomId, events);
    await Promise.all([
      this.state.set(this.pendingEventsKey(roomId), events, this.snapshotTtlMs),
      this.persistRoomIndex(this.pendingEventsIndexKey, this.pendingEventsByRoom),
    ]);
  }

  override async saveToDeviceBatches(
    batches: ToDeviceBatchWithTxnId[]
  ): Promise<void> {
    for (const batch of batches) {
      this.persistedToDeviceBatches.push({
        id: this.nextToDeviceBatchID++,
        eventType: batch.eventType,
        txnId: batch.txnId,
        batch: batch.batch,
      });
    }

    await Promise.all([
      this.state.set(
        this.toDeviceKey,
        { batches: this.persistedToDeviceBatches },
        this.snapshotTtlMs
      ),
      this.persistMeta(),
    ]);
  }

  override async getOldestToDeviceBatch(): Promise<IndexedToDeviceBatch | null> {
    return this.persistedToDeviceBatches[0] ?? null;
  }

  override async removeToDeviceBatch(id: number): Promise<void> {
    this.persistedToDeviceBatches = this.persistedToDeviceBatches.filter(
      (batch) => batch.id !== id
    );

    await this.state.set(
      this.toDeviceKey,
      { batches: this.persistedToDeviceBatches },
      this.snapshotTtlMs
    );
  }

  override getFilterIdByName(filterName: string): string | null {
    return this.filterIDs.get(filterName) ?? null;
  }

  override setFilterIdByName(filterName: string, filterId?: string): void {
    if (filterId) {
      this.filterIDs.set(filterName, filterId);
    } else {
      this.filterIDs.delete(filterName);
    }

    void this.persistMeta().catch((error) => {
      this.logger.warn("Failed to persist Matrix filter IDs", { error });
    });
  }

  override async deleteAllData(): Promise<void> {
    await super.deleteAllData();

    const oobRoomIDs = [...this.oobMembersByRoom.keys()];
    const pendingRoomIDs = [...this.pendingEventsByRoom.keys()];

    this.latestSavedSync = null;
    this.filterIDs.clear();
    this.oobMembersByRoom.clear();
    this.pendingEventsByRoom.clear();
    this.persistedToDeviceBatches = [];
    this.nextToDeviceBatchID = 0;
    this.dirty = false;
    this.newlyCreated = true;
    this.lastSavedAt = 0;

    await Promise.all([
      this.state.delete(this.metaKey),
      this.state.delete(this.savedSyncKey),
      this.state.delete(this.clientOptionsKey),
      this.state.delete(this.toDeviceKey),
      this.state.delete(this.oobMembersIndexKey),
      this.state.delete(this.pendingEventsIndexKey),
      ...oobRoomIDs.map((roomID) => this.state.delete(this.oobMembersKey(roomID))),
      ...pendingRoomIDs.map((roomID) => this.state.delete(this.pendingEventsKey(roomID))),
    ]);
  }

  override async destroy(): Promise<void> {
    await this.save(true);
  }

  private async loadIndexedRoomState(
    oobRoomIDsRaw: unknown,
    pendingRoomIDsRaw: unknown
  ): Promise<void> {
    const oobRoomIDs = normalizeRoomIndex(oobRoomIDsRaw);
    const pendingRoomIDs = normalizeRoomIndex(pendingRoomIDsRaw);

    await Promise.all([
      ...oobRoomIDs.map(async (roomID) => {
        const members = await this.state.get<IStateEventWithRoomId[] | null>(
          this.oobMembersKey(roomID)
        );
        if (members) {
          this.oobMembersByRoom.set(roomID, members);
        }
      }),
      ...pendingRoomIDs.map(async (roomID) => {
        const pending = await this.state.get<Partial<IEvent>[] | null>(
          this.pendingEventsKey(roomID)
        );
        if (pending) {
          this.pendingEventsByRoom.set(roomID, pending);
        }
      }),
    ]);

    if (oobRoomIDs.length > 0 || pendingRoomIDs.length > 0) {
      this.newlyCreated = false;
    }
  }

  private async persistMeta(): Promise<void> {
    const meta: PersistedMeta = {
      version: STORE_VERSION,
      updatedAt: new Date().toISOString(),
      lastSavedAt:
        this.lastSavedAt > 0 ? new Date(this.lastSavedAt).toISOString() : undefined,
      nextBatch: this.latestSavedSync?.nextBatch ?? super.getSyncToken() ?? undefined,
      filterIds: Object.fromEntries(this.filterIDs),
      nextToDeviceBatchID: this.nextToDeviceBatchID,
    };

    await this.state.set(this.metaKey, meta, this.snapshotTtlMs);
  }

  private async persistRoomIndex(
    key: string,
    collection: Map<string, unknown>
  ): Promise<void> {
    const value: PersistedIndex = {
      roomIDs: [...collection.keys()],
    };
    await this.state.set(key, value, this.snapshotTtlMs);
  }

  private get metaKey(): string {
    return `${this.scopeKey}:meta`;
  }

  private get savedSyncKey(): string {
    return `${this.scopeKey}:saved-sync`;
  }

  private get clientOptionsKey(): string {
    return `${this.scopeKey}:client-options`;
  }

  private get toDeviceKey(): string {
    return `${this.scopeKey}:to-device`;
  }

  private get oobMembersIndexKey(): string {
    return `${this.scopeKey}:room-index:oob-members`;
  }

  private get pendingEventsIndexKey(): string {
    return `${this.scopeKey}:room-index:pending-events`;
  }

  private oobMembersKey(roomID: string): string {
    return `${this.scopeKey}:oob-members:${encodeURIComponent(roomID)}`;
  }

  private pendingEventsKey(roomID: string): string {
    return `${this.scopeKey}:pending-events:${encodeURIComponent(roomID)}`;
  }
}
