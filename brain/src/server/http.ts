import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  ActionReport,
  CultureSignal,
  DailyOutcome,
  InventoryDeltaSummary,
  MemoryObservation,
  ProtectedArea,
  ResidentPresentationSource,
  ResidentPresentationState
} from "@resident/shared";
import { MemoryManager } from "../memory/memory-manager";
import { SleepCore } from "../sleep/sleep-core";
import { ResidentEmotionEvent } from "../emotion-core";

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

type BrainBridgeEvent =
  | {
      type: "player_feedback";
      timestamp: string;
      player: { name: string };
      message: string;
    }
  | {
      type: "resident_status";
      timestamp: string;
      player: {
        name: string;
        location?: { x: number; y: number; z: number };
      };
      status: string;
      origin?: string;
    }
  | {
      type: "protected_area_conflict";
      timestamp: string;
      player: {
        name: string;
        location?: { x: number; y: number; z: number };
      };
      action: string;
      area: {
        id: string;
        label: string;
        owner?: string;
        world?: string;
        center?: { x: number; y: number; z: number };
        radius?: number;
      };
    }
  | {
      type: "protected_areas_snapshot";
      timestamp: string;
      reason?: string;
      area_count?: number;
      areas: ProtectedArea[];
    }
  | {
      type: "resident_life";
      timestamp: string;
      player: {
        name: string;
        location?: { x: number; y: number; z: number };
      };
      status: string;
      origin?: string;
      details?: string;
    }
  | {
      type: "resident_death";
      timestamp: string;
      player: {
        name: string;
        world?: string;
        location?: { x: number; y: number; z: number };
      };
      death_message?: string;
      cause?: string;
      world?: {
        name?: string;
      };
      death_location?: { x: number; y: number; z: number };
      dropped_items?: InventoryDeltaSummary[] | Record<string, number>;
      dropped_stack_count?: number;
      dropped_item_total?: number;
      keep_inventory?: boolean;
      keep_level?: boolean;
    }
  | {
      type: "resident_respawn";
      timestamp: string;
      player: {
        name: string;
        world?: string;
        location?: { x: number; y: number; z: number };
      };
      respawn_location?: { x: number; y: number; z: number };
      respawn_world?: {
        name?: string;
      };
      bed_spawn?: boolean;
      anchor_spawn?: boolean;
      respawn_reason?: string;
    }
  | {
      type: "animal_bond";
      timestamp: string;
      player: {
        name: string;
        world?: string;
        location?: { x: number; y: number; z: number };
      };
      animal: {
        id?: string;
        species: string;
        name?: string;
        location?: { x: number; y: number; z: number };
      };
      bond_kind?: "familiar" | "companion" | "caretaking";
      reason?: string;
    }
  | {
      type: "animal_birth";
      timestamp: string;
      player: {
        name: string;
        world?: string;
        location?: { x: number; y: number; z: number };
      };
      animal: {
        species: string;
        offspring_name?: string;
        herd_id?: string;
        location?: { x: number; y: number; z: number };
      };
      breeder?: {
        name?: string;
      };
    }
  | {
      type: "resident_bed_event";
      timestamp: string;
      player: {
        name: string;
        world?: string;
        location?: { x: number; y: number; z: number };
      };
      result: string;
      accepted: boolean;
    }
  | {
      type: "player_chat";
      timestamp: string;
      player: {
        name: string;
        world?: string;
        location?: { x: number; y: number; z: number };
      };
      message: string;
      near_resident?: boolean;
    }
  | {
      type: "world_weather";
      timestamp: string;
      world: {
        name: string;
        environment?: string;
        difficulty?: string;
        time?: number;
        full_time?: number;
      };
      storming: boolean;
      thundering: boolean;
    };

export interface ResidentBrainServerOptions {
  presentation?: ResidentPresentationSource;
}

function inferCultureSignalFromMessage(playerName: string, message: string, timestamp: string): CultureSignal {
  const lower = message.toLowerCase();
  const valence = lower.includes("love") || lower.includes("good") || lower.includes("thank") || lower.includes("beautiful") ? 1 : -1;
  const topic = lower.includes("farm")
    ? "farm"
    : lower.includes("animal")
      ? "animal"
      : lower.includes("build")
        ? "build"
        : lower.includes("guest") || lower.includes("social")
          ? "social"
          : "general";

  return {
    source_player: playerName,
    signal_type: lower.includes("thank")
      ? "thank_you"
      : lower.includes("gift") || lower.includes("take this")
        ? "gift"
        : lower.includes("come") || lower.includes("visit") || lower.includes("join")
          ? "invitation"
          : valence > 0
            ? "praise"
            : "critique",
    topic,
    valence,
    strength: 3,
    notes: message,
    timestamp
  };
}

function eventToCultureSignal(event: Extract<BrainBridgeEvent, { type: "player_feedback" | "player_chat" }>): CultureSignal {
  return inferCultureSignalFromMessage(event.player.name, event.message, event.timestamp);
}

function shouldTreatChatAsCultureSignal(event: Extract<BrainBridgeEvent, { type: "player_chat" }>): boolean {
  const lower = event.message.toLowerCase();
  return ["thank", "love", "beautiful", "good", "bad", "ugly", "come", "visit", "join", "gift", "take this"].some((term) =>
    lower.includes(term)
  );
}

function eventToObservation(event: BrainBridgeEvent): MemoryObservation {
  if (event.type === "player_feedback") {
    return {
      timestamp: event.timestamp,
      category: "social",
      summary: `Player ${event.player.name} said: ${event.message}`,
      tags: ["player", "feedback", event.player.name],
      importance: 0.55,
      source: "dialogue"
    };
  }

  if (event.type === "protected_area_conflict") {
    return {
      timestamp: event.timestamp,
      category: "danger",
      summary: `Protected area conflict while trying to ${event.action} in ${event.area.label}.`,
      tags: ["protected-area", "boundary", event.action, event.area.label],
      importance: 0.8,
      source: "action",
      location: event.player.location
    };
  }

  if (event.type === "resident_death") {
    const droppedItems = normalizeDroppedItems(event.dropped_items);
    const inventoryLoss = summarizeDroppedItems(droppedItems);
    return {
      timestamp: event.timestamp,
      category: "danger",
      summary: event.death_message?.trim()
        ? `I died: ${event.death_message}${inventoryLoss ? ` I lost ${inventoryLoss}.` : ""}`
        : `I died${event.cause ? ` from ${event.cause}` : ""}${inventoryLoss ? ` and lost ${inventoryLoss}` : ""}.`,
      tags: ["resident", "death", event.cause ?? "unknown-cause", ...droppedItems.map((item) => item.item)],
      importance: 0.95,
      source: "action",
      location: event.death_location ?? event.player.location
    };
  }

  if (event.type === "resident_respawn") {
    return {
      timestamp: event.timestamp,
      category: "recovery",
      summary: event.bed_spawn
        ? "I woke again in a safer place and needed a moment to read the world."
        : "I came back after dying and had to learn the room around me again.",
      tags: ["resident", "respawn", event.bed_spawn ? "bed" : event.anchor_spawn ? "anchor" : "wild", event.respawn_reason ?? "unknown-reason"],
      importance: 0.88,
      source: "action",
      location: event.respawn_location ?? event.player.location
    };
  }

  if (event.type === "animal_bond") {
    const label = event.animal.name?.trim() || event.animal.species;
    return {
      timestamp: event.timestamp,
      category: "social",
      summary: `A bond formed with ${label}.`,
      tags: ["bonding", "pet", event.animal.species, label, event.bond_kind ?? "companion"],
      importance: 0.82,
      source: "action",
      location: event.animal.location ?? event.player.location
    };
  }

  if (event.type === "animal_birth") {
    return {
      timestamp: event.timestamp,
      category: "livestock",
      summary: `New ${event.animal.species} life arrived nearby${event.breeder?.name ? ` with ${event.breeder.name} involved` : ""}.`,
      tags: ["birth", "nurture", "livestock", event.animal.species, event.animal.offspring_name ?? "newborn"],
      importance: 0.8,
      source: "action",
      location: event.animal.location ?? event.player.location
    };
  }

  if (event.type === "resident_bed_event") {
    return {
      timestamp: event.timestamp,
      category: event.accepted ? "sleep" : "danger",
      summary: event.accepted
        ? "I reached bed and the world finally let me rest."
        : `Bed entry failed with ${event.result}.`,
      tags: ["resident", "bed", event.result, event.accepted ? "rest" : "blocked"],
      importance: event.accepted ? 0.65 : 0.75,
      source: "action",
      location: event.player.location
    };
  }

  if (event.type === "player_chat") {
    return {
      timestamp: event.timestamp,
      category: event.near_resident ? "social" : "hospitality",
      summary: `${event.player.name} said: ${event.message}`,
      tags: ["chat", "player", event.player.name, event.near_resident ? "nearby" : "ambient"],
      importance: event.near_resident ? 0.6 : 0.35,
      source: "dialogue",
      location: event.player.location
    };
  }

  if (event.type === "world_weather") {
    const weather = event.thundering ? "thunder" : event.storming ? "rain" : "clear";
    return {
      timestamp: event.timestamp,
      category: "weather",
      summary: `The weather in ${event.world.name} shifted to ${weather}.`,
      tags: ["weather", weather, event.world.name],
      importance: weather === "clear" ? 0.3 : 0.55,
      source: "perception"
    };
  }

  if (event.type === "resident_life") {
    return {
      timestamp: event.timestamp,
      category: event.status === "died" ? "danger" : event.status === "sleeping" ? "sleep" : "social",
      summary: `Resident ${event.player.name} is ${event.status}${event.details ? `: ${event.details}` : ""}.`,
      tags: ["resident", event.status, event.origin ?? "plugin"],
      importance: event.status === "died" ? 0.9 : 0.5,
      source: "action",
      location: event.player.location
    };
  }

  if (event.type === "resident_status") {
    return {
      timestamp: event.timestamp,
      category: "social",
      summary: `Player ${event.player.name} is ${event.status} via ${event.origin ?? "plugin"}.`,
      tags: ["player", "presence", event.status],
      importance: 0.35,
      source: "perception",
      location: event.player.location
    };
  }

  return {
    timestamp: event.timestamp,
    category: "project",
    summary: `Boundaries updated${event.type === "protected_areas_snapshot" && event.reason ? `: ${event.reason}` : ""}.`,
    tags: ["protected-area", "boundary", "snapshot"],
    importance: 0.4,
    source: "reflection"
  };
}

export function createResidentBrainServer(
  memory: MemoryManager,
  sleepCore: SleepCore,
  port = 4318,
  options: ResidentBrainServerOptions = {}
) {
  const emptyPresentationState: ResidentPresentationState = { thought: null };
  let mirroredPresentationState: ResidentPresentationState = emptyPresentationState;

  const readPresentationState = () =>
    options.presentation?.getPresentationState() ?? pruneExpiredPresentationState(mirroredPresentationState);

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.method === "GET" && request.url === "/resident/presentation") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(readPresentationState()));
        return;
      }

      if (request.method === "POST" && request.url === "/resident/presentation") {
        mirroredPresentationState = pruneExpiredPresentationState(await readJson<ResidentPresentationState>(request));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify(readPresentationState()));
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      if (request.method === "GET" && request.url === "/memory") {
        const current = await memory.current();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(current));
        return;
      }

      if (request.method === "POST" && request.url === "/memory/observations") {
        const body = await readJson<MemoryObservation>(request);
        const next = await memory.remember(body);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify(next));
        return;
      }

      if (request.method === "POST" && request.url === "/memory/reports") {
        const body = await readJson<ActionReport>(request);
        const next = await memory.rememberReport(body);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify(next));
        return;
      }

      if (request.method === "POST" && request.url === "/memory/protected-areas") {
        const body = await readJson<{ areas: ProtectedArea[] }>(request);
        const next = await memory.setProtectedAreas(body.areas ?? []);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify(next));
        return;
      }

      if (request.method === "POST" && request.url === "/culture") {
        const body = await readJson<CultureSignal>(request);
        await sleepCore.ingestCultureSignal(body);
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "queued" }));
        return;
      }

      if (request.method === "POST" && request.url === "/sleep") {
        const body = await readJson<{ agentId?: string; outcome: DailyOutcome }>(request);
        const bundle = await memory.buildBundle(body.agentId ?? "resident-1");
        try {
          const record = await sleepCore.consolidate(bundle, body.outcome);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(record));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const queued = await memory.queueSleepWork(bundle, body.outcome, message);
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "queued", queued }));
        }
        return;
      }

      if (request.method === "GET" && request.url === "/sleep/latest") {
        const overnight = await sleepCore.latestOvernight();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(overnight ?? null));
        return;
      }

      if (request.method === "POST" && request.url === "/brain/events") {
        const body = await readJson<BrainBridgeEvent>(request);
        if (body.type === "player_feedback" || (body.type === "player_chat" && shouldTreatChatAsCultureSignal(body))) {
          await sleepCore.ingestCultureSignal(eventToCultureSignal(body));
        } else if (body.type === "protected_areas_snapshot") {
          await memory.setProtectedAreas(body.areas ?? []);
          response.writeHead(202, { "content-type": "application/json" });
          response.end(JSON.stringify({ status: "accepted" }));
          return;
        }
        if (body.type === "protected_area_conflict") {
          await memory.mergeProtectedAreas(
            body.area
              ? [
                  {
                    id: body.area.id,
                    label: body.area.label,
                    owner: body.area.owner,
                    world: body.area.world,
                    center: body.area.center ?? body.player.location ?? { x: 0, y: 64, z: 0 },
                    radius: body.area.radius ?? 8
                  }
                ]
              : []
          );
        }
        if (
          body.type === "resident_death" ||
          body.type === "resident_respawn" ||
          body.type === "animal_bond" ||
          body.type === "animal_birth"
        ) {
          await memory.applyResidentEmotionEvent(eventToResidentEmotionEvent(body));
        }
        await memory.remember(eventToObservation(body));
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "accepted" }));
        return;
      }

      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  }).listen(port);
}

function eventToResidentEmotionEvent(
  event: Extract<BrainBridgeEvent, { type: "resident_death" | "resident_respawn" | "animal_bond" | "animal_birth" }>
): ResidentEmotionEvent {
  if (event.type === "resident_death") {
    const dropped_items = normalizeDroppedItems(event.dropped_items);
    return {
      type: "resident_death",
      timestamp: event.timestamp,
      cause_tags: ["death", event.cause ?? "unknown-cause"],
      death_message: event.death_message,
      dropped_items,
      location: event.death_location ?? event.player.location,
      world: event.world?.name ?? event.player.world
    };
  }

  if (event.type === "animal_bond") {
    return {
      type: "animal_bond",
      timestamp: event.timestamp,
      cause_tags: compactCauseTags(["bonding", event.reason, event.animal.species]),
      animal_label: event.animal.name?.trim() || event.animal.species,
      animal_id: event.animal.id,
      bond_kind: event.bond_kind,
      location: event.animal.location ?? event.player.location,
      world: event.player.world
    };
  }

  if (event.type === "animal_birth") {
    return {
      type: "animal_birth",
      timestamp: event.timestamp,
      cause_tags: compactCauseTags(["birth", event.animal.species, event.breeder?.name ? "witnessed" : undefined]),
      species: event.animal.species,
      offspring_label: event.animal.offspring_name,
      herd_id: event.animal.herd_id,
      location: event.animal.location ?? event.player.location,
      world: event.player.world
    };
  }

  return {
    type: "resident_respawn",
    timestamp: event.timestamp,
    cause_tags: ["respawn", event.respawn_reason ?? (event.bed_spawn ? "bed" : event.anchor_spawn ? "anchor" : "respawn")],
    respawn_location: event.respawn_location ?? event.player.location,
    location: event.player.location,
    world: event.respawn_world?.name ?? event.player.world,
    bed_spawn: event.bed_spawn
  };
}

function compactCauseTags(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function normalizeDroppedItems(items: InventoryDeltaSummary[] | Record<string, number> | undefined): InventoryDeltaSummary[] {
  if (!items) {
    return [];
  }

  if (Array.isArray(items)) {
    return items
      .filter((item) => item.item && item.count > 0)
      .map((item) => ({ item: item.item, count: item.count }));
  }

  return Object.entries(items)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([item, count]) => ({ item, count }));
}

function summarizeDroppedItems(items: InventoryDeltaSummary[] | undefined): string {
  if (!items || items.length === 0) {
    return "";
  }

  return items
    .slice(0, 3)
    .map((item) => `${item.count} ${item.item}`)
    .join(", ");
}

function pruneExpiredPresentationState(state: ResidentPresentationState, nowMs = Date.now()): ResidentPresentationState {
  const thought = state?.thought;
  if (!thought) {
    return { thought: null };
  }

  const expiresAtMs = Date.parse(thought.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    return { thought: null };
  }

  return {
    thought: { ...thought }
  };
}
