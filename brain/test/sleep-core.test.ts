import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileBackedSleepStore } from "../src/sleep/file-store";
import { SleepCore } from "../src/sleep/sleep-core";

describe("SleepCore", () => {
  it("consolidates a memory bundle into overnight output instead of a morning brief", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-sleep-"));
    try {
      const store = new FileBackedSleepStore(join(dir, "sleep.json"));
      const sleepCore = new SleepCore(store);
      const record = await sleepCore.consolidate(
        {
          agent_id: "resident-1",
          day_number: 3,
          created_at: new Date().toISOString(),
          summary: "A hard but meaningful day.",
          observations: [
            {
              timestamp: new Date().toISOString(),
              category: "danger",
              summary: "Barely escaped a skeleton at dusk.",
              tags: ["danger", "combat", "dusk"],
              importance: 0.9,
              source: "action"
            },
            {
              timestamp: new Date().toISOString(),
              category: "beauty",
              summary: "The doorway looked warm in the rain.",
              tags: ["beauty", "home", "rain"],
              importance: 0.7,
              source: "reflection"
            }
          ],
          active_projects: [],
          carry_over_commitments: ["repair the doorway"],
          recent_dangers: ["Skeleton near the tree line."],
          recent_interactions: [],
          place_tags: ["home", "quiet corner"],
          final_affect: {
            mood: 0.6,
            stress: 0.5,
            loneliness: 0.3,
            wonder: 0.6,
            security: 0.55,
            belonging: 0.7,
            satisfaction: 0.58
          }
        },
        {
          dayNumber: 3,
          survived: true,
          sleptInBed: true,
          mealsConsumed: 3,
          hungerEmergencies: 0,
          damageTaken: 7,
          combatsWon: 0,
          retreatsUsed: 1,
          hostedPlayers: 0,
          explorationMoments: 1,
          craftedItems: 0,
          buildActions: 2,
          livestockStable: true,
          joyMoments: 1,
          setbacksFaced: 1,
          recoveryMoments: 1,
          meaningMoments: 1
        }
      );

      expect(record.overnight.carry_over_commitments).toContain("repair the doorway");
      expect(record.overnight.insights.length).toBeGreaterThan(0);
      expect(await sleepCore.latestOvernight()).toEqual(record.overnight);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
