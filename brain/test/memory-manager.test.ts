import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryState } from "../src/memory/memory-state";
import { FileBackedMemoryStore } from "../src/memory/file-store";
import { MemoryManager } from "../src/memory/memory-manager";
import { FileBackedSleepStore } from "../src/sleep/file-store";
import { SleepCore } from "../src/sleep/sleep-core";

describe("MemoryManager.recall", () => {
  it("recalls from awake and long-term memory sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-memory-recall-"));
    try {
      const memoryStore = new FileBackedMemoryStore(join(dir, "memory.json"));
      const sleepStore = new FileBackedSleepStore(join(dir, "sleep.json"));
      const memory = new MemoryManager(memoryStore, sleepStore);
      const sleepCore = new SleepCore(sleepStore, {
        modelName: "sleep-test",
        async synthesize() {
          return {
            summary: "A garden-focused day.",
            insights: ["Remember the garden path when making home."],
            risk_themes: [],
            place_memories: ["rose garden"],
            project_memories: ["Garden Bridge: Strengthen the rose garden crossing."],
            creative_motifs: ["The rose garden arch felt welcoming at dusk."]
          };
        }
      });
      const timestamp = "2026-03-09T12:00:00.000Z";

      await memory.replace({
        ...createMemoryState(),
        recent_observations: [
          {
            timestamp,
            category: "beauty",
            summary: "Lantern light made the harbor bakery feel like home.",
            tags: ["beauty", "home", "bakery", "garden"],
            importance: 0.7,
            source: "reflection"
          }
        ],
        self_narrative: [
          "Lantern light made the harbor bakery feel like home."
        ],
        active_projects: [
          {
            id: "bakery",
            title: "Bakery",
            kind: "build",
            status: "active",
            summary: "Expand the harbor bakery terrace.",
            updated_at: timestamp
          }
        ],
        carry_over_commitments: ["Repair the harbor bakery awning."],
        place_tags: ["harbor bakery"],
        last_updated_at: timestamp
      });

      await sleepCore.consolidate(
        {
          agent_id: "resident-1",
          day_number: 8,
          created_at: timestamp,
          summary: "A garden-focused day.",
          personality_profile: createMemoryState().personality_profile,
          self_name: "Juniper",
          need_state: createMemoryState().need_state,
          mind_state: createMemoryState().mind_state,
          bootstrap_progress: createMemoryState().bootstrap_progress,
          observations: [
            {
              timestamp,
              category: "beauty",
              summary: "The rose garden arch felt welcoming at dusk.",
              tags: ["beauty", "home", "garden"],
              importance: 0.8,
              source: "reflection"
            }
          ],
          active_projects: [
            {
              id: "garden-bridge",
              title: "Garden Bridge",
              kind: "build",
              status: "active",
              summary: "Strengthen the rose garden crossing.",
              updated_at: timestamp
            }
          ],
          carry_over_commitments: ["Keep the garden lanterns lit."],
          recent_dangers: [],
          recent_interactions: [],
          recent_action_snapshots: [],
          place_tags: ["rose garden"],
          final_affect: {
            mood: 0.7,
            stress: 0.2,
            loneliness: 0.2,
            wonder: 0.8,
            security: 0.7,
            belonging: 0.75,
            satisfaction: 0.8
          }
        },
        {
          dayNumber: 8,
          survived: true,
          sleptInBed: true,
          mealsConsumed: 2,
          hungerEmergencies: 0,
          damageTaken: 0,
          combatsWon: 0,
          retreatsUsed: 0,
          hostedPlayers: 0,
          explorationMoments: 1,
          craftedItems: 0,
          buildActions: 1,
          livestockStable: true,
          joyMoments: 1,
          setbacksFaced: 0,
          recoveryMoments: 0,
          meaningMoments: 1
        }
      );

      const recall = await memory.recall({
        query: "home",
        tags: ["bakery", "garden"],
        place: "harbor bakery",
        limit: 10
      });

      expect(recall.matches.some((match) => match.summary === "Lantern light made the harbor bakery feel like home.")).toBe(true);
      expect(recall.matches.some((match) => match.summary === "Garden Bridge: Strengthen the rose garden crossing.")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates identical awake recall candidates that share timestamp and summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resident-memory-dedupe-"));
    try {
      const sleepStore = new FileBackedSleepStore(join(dir, "sleep.json"));
      const memory = new MemoryManager(
        new FileBackedMemoryStore(join(dir, "memory.json")),
        sleepStore
      );
      const timestamp = "2026-03-09T15:00:00.000Z";

      await memory.replace({
        ...createMemoryState(),
        recent_observations: [
          {
            timestamp,
            category: "beauty",
            summary: "The workshop doorway felt safe again.",
            tags: ["home", "workshop"],
            importance: 0.6,
            source: "reflection"
          }
        ],
        self_narrative: ["The workshop doorway felt safe again."],
        last_updated_at: timestamp
      });

      const recall = await memory.recall({
        query: "workshop doorway",
        limit: 5
      });

      const duplicates = recall.matches.filter((match) => match.summary === "The workshop doorway felt safe again.");
      expect(duplicates).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
