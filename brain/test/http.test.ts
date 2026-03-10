import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LIVESTOCK_STATE, DailyOutcome, PerceptionFrame, ResidentPresentationSource } from "@resident/shared";
import { FileBackedMemoryStore } from "../src/memory/file-store";
import { MemoryManager } from "../src/memory/memory-manager";
import { createResidentBrainServer } from "../src/server/http";
import { FileBackedSleepStore } from "../src/sleep/file-store";
import { SleepConsolidator, SleepCore } from "../src/sleep/sleep-core";

const defaultOutcome: DailyOutcome = {
  dayNumber: 0,
  survived: true,
  sleptInBed: true,
  mealsConsumed: 2,
  hungerEmergencies: 0,
  damageTaken: 0,
  combatsWon: 0,
  retreatsUsed: 0,
  hostedPlayers: 1,
  explorationMoments: 1,
  craftedItems: 0,
  buildActions: 1,
  livestockStable: true,
  joyMoments: 1,
  setbacksFaced: 0,
  recoveryMoments: 1,
  meaningMoments: 1
};

describe("createResidentBrainServer", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  it("replaces protected areas when a snapshot event arrives", async () => {
    const { postEvent, memory } = await createHarness(cleanups);

    await postEvent({
      type: "protected_areas_snapshot",
      timestamp: new Date().toISOString(),
      reason: "startup",
      areas: [
        { id: "one", label: "Starter Base", center: { x: 1, y: 64, z: 1 }, radius: 8 },
        { id: "two", label: "Village", center: { x: 20, y: 70, z: -2 }, radius: 12 }
      ]
    });

    let state = await memory.current();
    expect(state.protected_areas.map((area) => area.id)).toEqual(["one", "two"]);

    await postEvent({
      type: "protected_areas_snapshot",
      timestamp: new Date().toISOString(),
      reason: "remove",
      areas: [{ id: "three", label: "Sanctuary", center: { x: -10, y: 64, z: 5 }, radius: 6 }]
    });

    state = await memory.current();
    expect(state.protected_areas.map((area) => area.id)).toEqual(["three"]);
    expect(state.self_narrative.at(-1)).toContain("deserve careful respect");
  });

  it("records death, bed, chat, and weather events into unified awake memory", async () => {
    const { postEvent, memory } = await createHarness(cleanups);

    await postEvent({
      type: "resident_death",
      timestamp: new Date().toISOString(),
      player: {
        name: "resident-1",
        world: "world",
        location: { x: 5, y: 64, z: 5 }
      },
      death_message: "resident-1 was blown up by Creeper",
      cause: "entity_explosion"
    });

    await postEvent({
      type: "resident_bed_event",
      timestamp: new Date().toISOString(),
      player: {
        name: "resident-1",
        world: "world",
        location: { x: 0, y: 64, z: 0 }
      },
      result: "ok",
      accepted: true
    });

    await postEvent({
      type: "player_chat",
      timestamp: new Date().toISOString(),
      player: {
        name: "Alex",
        world: "world",
        location: { x: 1, y: 64, z: 1 }
      },
      message: "Your home looks beautiful tonight.",
      near_resident: true
    });

    await postEvent({
      type: "world_weather",
      timestamp: new Date().toISOString(),
      world: {
        name: "world",
        environment: "normal",
        difficulty: "easy",
        time: 13000,
        full_time: 13000
      },
      storming: true,
      thundering: false
    });

    const state = await memory.current();
    expect(state.recent_dangers.some((entry) => entry.includes("blown up"))).toBe(true);
    expect(state.recent_interactions.some((entry) => entry.includes("Alex said"))).toBe(true);
    expect(state.recent_observations.some((entry) => entry.category === "sleep")).toBe(true);
    expect(state.recent_observations.some((entry) => entry.category === "weather" && entry.summary.includes("rain"))).toBe(true);
  });

  it("feeds meaningful chat into sleep-core culture signals", async () => {
    const { postEvent, memory, sleepCore } = await createHarness(cleanups);

    await postEvent({
      type: "player_chat",
      timestamp: new Date().toISOString(),
      player: {
        name: "Alex",
        world: "world",
        location: { x: 2, y: 64, z: 2 }
      },
      message: "Thank you for making such a cozy home.",
      near_resident: true
    });

    const bundle = await memory.buildBundle("resident-1");
    const record = await sleepCore.consolidate(bundle, {
      ...defaultOutcome,
      dayNumber: bundle.day_number
    });

    expect(record.overnight.value_shift_summary.some((entry) => entry.includes("cozy home"))).toBe(true);
  });

  it("queues sleep work in awake memory when model-backed consolidation fails", async () => {
    const { port, memory } = await createHarness(cleanups, {
      consolidator: {
        modelName: "sleep-test",
        synthesize: vi.fn(async () => {
          throw new Error("model offline");
        })
      }
    });

    const observationResponse = await fetch(`http://127.0.0.1:${port}/memory/observations`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        category: "sleep",
        summary: "The resident is ready to hand the day to sleep.",
        tags: ["sleep", "handoff"],
        importance: 0.8,
        source: "action"
      })
    });
    expect(observationResponse.status).toBe(202);

    const response = await fetch(`http://127.0.0.1:${port}/sleep`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        agentId: "resident-1",
        outcome: defaultOutcome
      })
    });

    expect(response.status).toBe(202);
    const pending = await memory.pendingSleepWork();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.last_error).toContain("Sleep consolidation failed.");
    expect(pending[0]?.last_error).toContain("sleep-test");
  });

  it("exposes the current resident presentation state", async () => {
    const presentation: ResidentPresentationSource = {
      getPresentationState() {
        return {
          thought: {
            residentId: "resident-1",
            residentName: "resident-1",
            text: "I should check the fields before dusk.",
            createdAt: "2026-03-09T12:00:00.000Z",
            expiresAt: "2026-03-09T12:00:06.000Z"
          }
        };
      }
    };
    const { port } = await createHarness(cleanups, { presentation });

    const response = await fetch(`http://127.0.0.1:${port}/resident/presentation`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      thought: {
        residentId: "resident-1",
        residentName: "resident-1",
        text: "I should check the fields before dusk.",
        createdAt: "2026-03-09T12:00:00.000Z",
        expiresAt: "2026-03-09T12:00:06.000Z"
      }
    });
  });
});

async function createHarness(
  cleanups: Array<() => Promise<void>>,
  options: { consolidator?: SleepConsolidator; presentation?: ResidentPresentationSource } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "resident-brain-http-"));
  const sleepStore = new FileBackedSleepStore(join(dir, "sleep.json"));
  const memory = new MemoryManager(new FileBackedMemoryStore(join(dir, "memory.json")), sleepStore);
  await memory.syncPerception(basePerception);
  const sleepCore = new SleepCore(sleepStore, options.consolidator ?? createHarnessConsolidator());
  const server = createResidentBrainServer(memory, sleepCore, 0, {
    presentation: options.presentation
  });
  const port = (server.address() as AddressInfo).port;

  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  return {
    port,
    memory,
    sleepCore,
    async postEvent(event: Record<string, unknown>) {
      const response = await fetch(`http://127.0.0.1:${port}/brain/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(event)
      });
      expect(response.status).toBe(202);
      return response.json();
    }
  };
}

const basePerception: PerceptionFrame = {
  agent_id: "resident-1",
  tick_time: 6000,
  position: { x: 0, y: 64, z: 0 },
  weather: "clear",
  light_level: 15,
  health: 20,
  hunger: 18,
  inventory: { oak_log: 8, oak_planks: 8 },
  nearby_entities: [],
  nearby_blocks: [],
  home_state: {
    anchor: { x: 0, y: 64, z: 0 },
    shelterScore: 0.8,
    bedAvailable: true,
    workshopReady: true,
    guestCapacity: 0
  },
  snapshot_refs: [],
  notable_places: [],
  pantry_state: {
    carriedCalories: 200,
    pantryCalories: 200,
    cookedMeals: 1,
    cropReadiness: 0,
    emergencyReserveDays: 2
  },
  farm_state: {
    farmlandReady: false,
    plantedCrops: [],
    hydratedTiles: 0,
    harvestableTiles: 0,
    seedStock: {}
  },
  livestock_state: DEFAULT_LIVESTOCK_STATE,
  combat_state: {
    hostilesNearby: 0,
    armorScore: 0,
    weaponTier: "none",
    escapeRouteKnown: true
  },
  safe_route_state: {
    homeRouteKnown: true,
    nearestShelter: { x: 0, y: 64, z: 0 },
    nightSafeRadius: 24
  },
  workstation_state: {
    craftingTableNearby: true,
    furnaceNearby: false,
    smokerNearby: false,
    blastFurnaceNearby: false,
    chestNearby: false
  },
  storage_sites: [],
  crop_sites: [],
  terrain_affordances: [],
  protected_areas: [],
  settlement_zones: []
};

function createHarnessConsolidator(): SleepConsolidator {
  return {
    modelName: "sleep-test",
    synthesize: vi.fn(async () => ({
      summary: "A warm night gave the day a shape worth keeping.",
      insights: ["Protect the cozy doorway tomorrow."],
      risk_themes: ["Hostiles near the tree line."],
      place_memories: ["home"],
      project_memories: ["Doorway Repair: Keep the entrance dry and bright."],
      creative_motifs: ["The doorway looked warm in the rain."]
    }))
  };
}
