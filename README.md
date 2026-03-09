# Minecraft Resident

An implementation scaffold for an autonomous Minecraft resident with:

- `brain/` for the wake brain, unified awake memory, and the rewritten TypeScript sleep-core
- `bot/` for the Mineflayer-driven body
- `plugin/` for slim Paper hooks and player-guided culture events
- `vendor/always-on-memory-agent/` as a design reference for the sleep rewrite

## What exists today

- Shared resident contracts for perception, crafting, building, unified memory, overnight consolidation, values, livestock, combat, and action reports.
- A wake-brain that performs wake orientation, classifies replanning triggers, and prioritizes hunger, danger, nightly sleep, crafting, and free building/rebuilding.
- An optional OpenAI executive layer that can choose non-urgent life directions while deterministic safety rules still guard danger, hunger, and sleep.
- A unified awake memory layer that tracks world facts, current goals, recent observations, self-narrative, and end-of-day memory bundles.
- A sleep-core service with a file-backed store, nightly consolidation, long-term recall, and value updates.
- Graceful degradation for sleep failures: awake memory can queue unfinished sleep bundles for later replay instead of losing the day.
- A semantic build planner for open-ended construction and remodeling.
- A recipe-driven craft planner using `minecraft-data`.
- A Mineflayer runtime wrapper plus a live driver that returns structured action reports for eating, crafting, mining, building, combat, recovery, and more.
- A resident runner that loops through perceive -> decide -> act -> remember -> sleep.
- A Paper plugin that posts protected-area snapshots, resident death/bed events, nearby chat, weather, player feedback, and status changes to the brain bridge while enforcing protected areas for the resident account.
- Unit tests for value updates, planning behavior, unified memory behavior, HTTP bridge events, and bot runtime ordering.

## Commands

```bash
npm install
npm test
npm run build
gradle -p plugin build
```

## Brain Server

Start the resident brain HTTP service:

```bash
node brain/dist/index.js brain
```

Endpoints:

- `GET /health`
- `GET /memory`
- `POST /memory/observations`
- `POST /memory/reports`
- `POST /memory/protected-areas`
- `POST /culture`
- `POST /sleep`
- `GET /sleep/latest`
- `POST /brain/events`

The Paper plugin is configured to post player/world events to `POST /brain/events`, including:

- protected-area snapshots and conflicts
- resident death and bed-entry events
- nearby player chat
- weather changes in the resident's world
- explicit player praise/critique feedback

If `POST /sleep` cannot reach a healthy sleep-core consolidation pass, the current `MemoryBundle` is queued in awake memory for later replay instead of being discarded.

## Run The Resident

Start the autonomous resident loop:

```bash
node bot/dist/index.js run
```

Useful environment variables:

- `MINECRAFT_HOST`
- `MINECRAFT_PORT`
- `MINECRAFT_USERNAME`
- `MINECRAFT_VERSION`
- `MINECRAFT_AUTH`
- `MINECRAFT_VIEWER_PORT`
- `RESIDENT_BRAIN_PORT`
- `RESIDENT_LOOP_MS`
- `OPENAI_API_KEY`
- `RESIDENT_OPENAI_MODEL`

If `OPENAI_API_KEY` is absent, the resident falls back to the deterministic wake-brain executive.

## Protected Areas

The Paper plugin can define regions the resident may not alter:

```text
/residentprotect add <id> [radius]
/residentprotect remove <id>
/residentprotect list
```

Set the resident account name in [`config.yml`](plugin/src/main/resources/config.yml) under `resident.username`.

## Notes

- Awake `memory` owns live world facts, short-horizon continuity, and the end-of-day `MemoryBundle`.
- `sleep-core` only runs sleep-time consolidation and long-term autobiographical integration; wake orientation is produced by the awake brain after reading the morning world state.
- The resident is designed around bounded flourishing rather than reward maximization, and happiness is allowed to survive failure.
- The runner emits structured JSON logs for planning turns, recall, action execution, memory handoff, consolidation, and value updates.
- ALMA is intentionally out of scope here.
