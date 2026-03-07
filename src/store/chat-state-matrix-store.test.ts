import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger, StateAdapter } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { IStateEventWithRoomId } from "matrix-js-sdk/lib/@types/search";
import type { IndexedToDeviceBatch } from "matrix-js-sdk/lib/models/ToDeviceMessage";
import { ChatStateMatrixStore } from "./chat-state-matrix-store";

function makeLogger(): Logger {
  return {
    child: () => makeLogger(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeSavedSync(nextBatch = "s1") {
  return {
    nextBatch,
    accountData: [
      {
        type: "m.direct",
        content: {
          "@alice:beeper.com": ["!room:beeper.com"],
        },
      },
    ],
    roomsData: {
      join: {
        "!room:beeper.com": {
          account_data: { events: [] },
          ephemeral: { events: [] },
          state: { events: [] },
          summary: {},
          timeline: {
            events: [],
            limited: false,
            prev_batch: "t0",
          },
          unread_notifications: {},
        },
      },
    },
  };
}

async function makeState(
  initial: Record<string, unknown> = {}
): Promise<StateAdapter> {
  const state = createMemoryState();
  await state.connect();
  for (const [key, value] of Object.entries(initial)) {
    await state.set(key, value);
  }
  return state;
}

async function makeStore(
  state: StateAdapter,
  options: Partial<ConstructorParameters<typeof ChatStateMatrixStore>[0]> = {}
) {
  const store = new ChatStateMatrixStore({
    state,
    scopeKey: "matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1",
    logger: makeLogger(),
    persistIntervalMs: 30_000,
    ...options,
  });
  await store.startup();
  return store;
}

describe("ChatStateMatrixStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads persisted saved sync during startup", async () => {
    const scope =
      "matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1";
    const state = await makeState({
      [`${scope}:meta`]: {
        version: 1,
        updatedAt: "2026-03-07T12:00:00.000Z",
        nextToDeviceBatchID: 0,
        filterIds: {},
        nextBatch: "s1",
      },
      [`${scope}:saved-sync`]: makeSavedSync(),
    });

    const store = await makeStore(state, { scopeKey: scope });
    const saved = await store.getSavedSync();

    expect(saved).toEqual(makeSavedSync());
    expect(await store.getSavedSyncToken()).toBe("s1");
    expect(await store.isNewlyCreated()).toBe(false);
  });

  it("reads saved sync token from meta without loading the full snapshot", async () => {
    const scope =
      "matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1";
    const state = await makeState({
      [`${scope}:meta`]: {
        version: 1,
        updatedAt: "2026-03-07T12:00:00.000Z",
        nextToDeviceBatchID: 0,
        filterIds: {},
        nextBatch: "s99",
      },
    });
    const getSpy = vi.spyOn(state, "get");
    const store = new ChatStateMatrixStore({
      state,
      scopeKey: scope,
      logger: makeLogger(),
      persistIntervalMs: 30_000,
    });

    expect(await store.getSavedSyncToken()).toBe("s99");
    expect(getSpy).toHaveBeenCalledWith(`${scope}:meta`);
    expect(getSpy).not.toHaveBeenCalledWith(`${scope}:saved-sync`);
  });

  it("marks sync data dirty and only persists on a forced save before the interval", async () => {
    const scope =
      "matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1";
    const state = await makeState({
      [`${scope}:meta`]: {
        version: 1,
        updatedAt: "2026-03-07T12:00:00.000Z",
        lastSavedAt: "2026-03-07T12:00:00.000Z",
        nextToDeviceBatchID: 0,
        filterIds: {},
        nextBatch: "s1",
      },
      [`${scope}:saved-sync`]: makeSavedSync(),
    });
    const setSpy = vi.spyOn(state, "set");
    const store = await makeStore(state, { scopeKey: scope });

    await store.setSyncData({
      next_batch: "s2",
      rooms: makeSavedSync("s2").roomsData,
      account_data: { events: makeSavedSync("s2").accountData },
    } as never);

    expect(store.wantsSave()).toBe(false);
    await store.save();
    expect(setSpy).not.toHaveBeenCalledWith(
      expect.stringContaining(":saved-sync"),
      expect.anything(),
      expect.anything()
    );

    await store.save(true);

    expect(setSpy).toHaveBeenCalledWith(
      expect.stringContaining(":saved-sync"),
      expect.objectContaining({ nextBatch: "s2" }),
      undefined
    );
    expect(setSpy).toHaveBeenCalledWith(
      expect.stringContaining(":meta"),
      expect.objectContaining({ nextBatch: "s2" }),
      undefined
    );
  });

  it("persists filter IDs, OOB members, pending events, and to-device batches across store instances", async () => {
    const state = await makeState();
    const first = await makeStore(state);
    const oobMembers: IStateEventWithRoomId[] = [
      {
        room_id: "!room:beeper.com",
        state_key: "@alice:beeper.com",
        type: "m.room.member",
        content: { membership: "join" },
      } as IStateEventWithRoomId,
    ];
    const pendingEvents = [{ event_id: "$pending" }];

    first.setFilterIdByName("sync", "filter-1");
    await first.setOutOfBandMembers("!room:beeper.com", oobMembers);
    await first.setPendingEvents("!room:beeper.com", pendingEvents);
    await first.saveToDeviceBatches([
      {
        eventType: "m.room_key",
        txnId: "txn-1",
        batch: [
          {
            userId: "@alice:beeper.com",
            deviceId: "DEVICE2",
            payload: {
              type: "m.room_key",
              content: { room_id: "!room:beeper.com" },
            },
          },
        ],
      },
    ]);

    const second = await makeStore(state);
    const toDevice = await second.getOldestToDeviceBatch();

    expect(second.getFilterIdByName("sync")).toBe("filter-1");
    expect(await second.getOutOfBandMembers("!room:beeper.com")).toEqual(oobMembers);
    expect(await second.getPendingEvents("!room:beeper.com")).toEqual(pendingEvents);
    expect(toDevice).toMatchObject<Partial<IndexedToDeviceBatch>>({
      id: 0,
      txnId: "txn-1",
      eventType: "m.room_key",
    });
  });

  it("deletes all persisted keys", async () => {
    const state = await makeState();
    const store = await makeStore(state);

    await store.setSyncData({
      next_batch: "s3",
      rooms: makeSavedSync("s3").roomsData,
      account_data: { events: makeSavedSync("s3").accountData },
    } as never);
    await store.setPendingEvents("!room:beeper.com", [{ event_id: "$pending" }]);
    await store.save(true);

    await store.deleteAllData();

    expect(await state.get("matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1:meta")).toBeNull();
    expect(
      await state.get(
        "matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1:saved-sync"
      )
    ).toBeNull();
    expect(
      await state.get(
        "matrix:store:v1:https%3A%2F%2Fhs.beeper.com:%40bot%3Abeeper.com:DEVICE1:pending-events:%21room%3Abeeper.com"
      )
    ).toBeNull();
  });
});
