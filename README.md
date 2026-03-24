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
- A sleep-core service with a file-backed store, dedicated-model nightly consolidation, long-term recall, and value updates.
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
npm run world
./plugin/gradlew build
```

`npm run world` bootstraps the full local stack. It builds the JS workspaces, builds the Paper plugin, downloads the latest stable Paper `1.21.4` server jar, writes the local Paper runtime under `.runtime/`, accepts the Minecraft EULA for this local bootstrap, generates a fresh world on first run, and starts the brain, server, and resident together in the foreground.

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

The resident viewer is served in third-person at [http://localhost:3000](http://localhost:3000) by default while the bot is running.

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
- `RESIDENT_REFLECTIVE_OPENAI_MODEL`

If `OPENAI_API_KEY` is absent, the resident falls back to the deterministic wake-brain executive.
`RESIDENT_REFLECTIVE_OPENAI_MODEL` is required for reflective-core startup. The same reflective model handles daytime life reflection and overnight sleep consolidation, while recall stays deterministic and memory-owned. It reuses `OPENAI_API_KEY` and `RESIDENT_OPENAI_BASE_URL`.

Set `MINECRAFT_VIEWER_PORT` to override the default viewer port.

## Local World Bootstrap

The one-command local world runner keeps generated runtime state under `.runtime/`:

- `.runtime/paper/paper-server.jar`
- `.runtime/paper/plugins/ResidentBridge.jar`
- `.runtime/paper/eula.txt`
- `.runtime/paper/server.properties`
- `.runtime/paper/world/` and the rest of the Paper server data

It reuses the existing environment variables for the stack:

- `MINECRAFT_PORT`
- `MINECRAFT_USERNAME`
- `MINECRAFT_VIEWER_PORT`
- `RESIDENT_BRAIN_PORT`

The full-stack launcher serves the bot viewer at [http://localhost:3000](http://localhost:3000) by default and opens it in your browser once the viewer is ready. Set `MINECRAFT_VIEWER_PORT` to override that port.

The launcher strips inherited LLM endpoint, model, and API-key variables before starting the local brain and bot, so `npm run world` does not ship or reuse hardcoded provider settings. Configure those explicitly when you want model-backed behavior outside the local bootstrap path.

The launcher manages the local EULA acceptance file automatically for this development workflow.

## Protected Areas

The Paper plugin can define regions the resident may not alter:

```text
/residentprotect add <id> [radius]
/residentprotect remove <id>
/residentprotect list
```

Set the resident account name in [`plugin/src/main/resources/config.yml`](plugin/src/main/resources/config.yml) under `resident.username`.

## Notes

- Awake `memory` owns live world facts, short-horizon continuity, daytime recall, and the end-of-day `MemoryBundle`.
- `sleep-core` still owns overnight consolidation and long-term autobiographical integration, but its configured reflective model now also runs event-driven daytime life reflection; wake orientation is still produced by the awake brain after reading the morning world state.
- The resident is designed around bounded flourishing rather than reward maximization, and happiness is allowed to survive failure.
- The runner emits structured JSON logs for planning turns, recall, action execution, memory handoff, consolidation, and value updates.
- ALMA is intentionally out of scope here.
