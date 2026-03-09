import { describe, expect, it, vi } from "vitest";
import { ActionReport, AgentIntent, PerceptionFrame } from "@resident/shared";
import { ResidentBotRuntime } from "../src";

describe("ResidentBotRuntime", () => {
  it("executes an intent before collecting perception", async () => {
    const trace: string[] = [];
    const perception: PerceptionFrame = {
      agent_id: "resident-1",
      tick_time: 0,
      position: { x: 0, y: 0, z: 0 },
      weather: "clear",
      light_level: 15,
      health: 20,
      hunger: 20,
      inventory: {},
      nearby_entities: [],
      nearby_blocks: [],
      home_state: {
        shelterScore: 0,
        bedAvailable: false,
        workshopReady: false,
        guestCapacity: 0
      },
      snapshot_refs: [],
      notable_places: [],
      pantry_state: {
        carriedCalories: 0,
        pantryCalories: 0,
        cookedMeals: 0,
        cropReadiness: 0,
        emergencyReserveDays: 0
      },
      farm_state: {
        farmlandReady: false,
        plantedCrops: [],
        hydratedTiles: 0,
        harvestableTiles: 0,
        seedStock: {}
      },
      livestock_state: {
        counts: {},
        targetRanges: {},
        enclosureStatus: {},
        outputs: {},
        welfareFlags: []
      },
      combat_state: {
        hostilesNearby: 0,
        armorScore: 0,
        weaponTier: "none",
        escapeRouteKnown: false
      },
      safe_route_state: {
        homeRouteKnown: false,
        nightSafeRadius: 0
      }
    };
    const driver = {
      executeIntent: vi.fn(async (): Promise<ActionReport> => {
        trace.push("execute");
        return {
          intent_type: "observe",
          status: "completed",
          notes: ["looked around"],
          damage_taken: 0,
          inventory_delta: {},
          world_delta: [],
          needs_replan: false
        };
      }),
      collectPerception: vi.fn(async () => {
        trace.push("perceive");
        return perception;
      })
    };

    const runtime = new ResidentBotRuntime(driver);
    const intent: AgentIntent = {
      agent_id: "resident-1",
      intent_type: "observe",
      reason: "look around",
      priority: 1,
      cancel_conditions: [],
      success_conditions: []
    };

    const result = await runtime.tick(intent);
    expect(trace).toEqual(["execute", "perceive"]);
    expect(result.report?.status).toBe("completed");
  });
});
