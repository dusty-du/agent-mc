import { EventEmitter } from "node:events";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Bot } from "mineflayer";
import { Server as SocketIOServer, Socket } from "socket.io";
import { viewer as prismarineViewer } from "prismarine-viewer";
import { ResidentPresentationState } from "@resident/shared";
import { ResidentPresentationController } from "./presentation-state";

type WorldViewCtor = new (
  world: Bot["world"],
  viewDistance?: number,
  position?: { x: number; y: number; z: number },
  emitter?: EventEmitter
) => {
  init(position: { x: number; y: number; z: number }): Promise<void>;
  updatePosition(position: { x: number; y: number; z: number }, force?: boolean): Promise<void>;
  listenToBot(bot: Bot): void;
  removeListenersFromBot(bot: Bot): void;
  on(event: "blockClicked", listener: (block: unknown, face: unknown, button: unknown) => void): void;
};

type ViewerPrimitive = Record<string, unknown> & { id: string };

type BotViewerApi = EventEmitter & {
  close: () => void;
  erase: (id: string) => void;
  drawBoxGrid: (id: string, start: unknown, end: unknown, color?: string) => void;
  drawLine: (id: string, points: unknown[], color?: number) => void;
  drawPoints: (id: string, points: unknown[], color?: number, size?: number) => void;
};

const WATCHER_ROOT = join(__dirname, "watcher");
const DEFAULT_VIEW_DISTANCE = 6;
const SOCKET_PATH = "/socket.io";
const WorldView = prismarineViewer.WorldView as WorldViewCtor;

export interface ResidentWatcherServerConfig {
  port: number;
  presentation: ResidentPresentationController;
  firstPerson?: boolean;
  viewDistance?: number;
}

export class ResidentWatcherServer {
  private readonly httpServer;
  private readonly io;
  private readonly sockets = new Set<Socket>();
  private readonly primitives: Record<string, ViewerPrimitive> = {};
  private readonly viewerApi = new EventEmitter() as BotViewerApi;
  private readonly viewDistance: number;
  private readonly firstPerson: boolean;

  constructor(
    private readonly bot: Bot,
    private readonly config: ResidentWatcherServerConfig
  ) {
    this.httpServer = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.io = new SocketIOServer(this.httpServer, { path: SOCKET_PATH });
    this.viewDistance = config.viewDistance ?? DEFAULT_VIEW_DISTANCE;
    this.firstPerson = config.firstPerson ?? false;
  }

  async start(): Promise<void> {
    this.installViewerApi();
    this.io.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.emit("version", this.bot.version);
      socket.emit("presentation", this.config.presentation.getPresentationState());

      const worldView = new WorldView(this.bot.world, this.viewDistance, this.bot.entity.position, socket as unknown as EventEmitter);
      void worldView.init(this.bot.entity.position);
      worldView.on("blockClicked", (block, face, button) => {
        this.viewerApi.emit("blockClicked", block, face, button);
      });

      for (const primitive of Object.values(this.primitives)) {
        socket.emit("primitive", primitive);
      }

      const emitBotPosition = () => {
        const packet: Record<string, unknown> = {
          pos: this.bot.entity.position,
          yaw: this.bot.entity.yaw,
          addMesh: true
        };
        if (this.firstPerson) {
          packet.pitch = this.bot.entity.pitch;
        }
        socket.emit("position", packet);
        void worldView.updatePosition(this.bot.entity.position);
      };

      this.bot.on("move", emitBotPosition);
      worldView.listenToBot(this.bot);
      emitBotPosition();

      socket.on("disconnect", () => {
        this.bot.removeListener("move", emitBotPosition);
        worldView.removeListenersFromBot(this.bot);
        this.sockets.delete(socket);
      });
    });

    this.config.presentation.on("update", this.handlePresentationUpdate);

    await new Promise<void>((resolve) => {
      this.httpServer.listen(this.config.port, resolve);
    });
  }

  close(): void {
    this.config.presentation.off("update", this.handlePresentationUpdate);
    this.io.close();
    this.httpServer.close();
  }

  private readonly handlePresentationUpdate = (state: ResidentPresentationState) => {
    for (const socket of this.sockets) {
      socket.emit("presentation", state);
    }
  };

  private installViewerApi(): void {
    this.viewerApi.close = () => this.close();
    this.viewerApi.erase = (id: string) => {
      delete this.primitives[id];
      this.broadcastPrimitive({ id });
    };
    this.viewerApi.drawBoxGrid = (id: string, start: unknown, end: unknown, color = "aqua") => {
      this.primitives[id] = { type: "boxgrid", id, start, end, color };
      this.broadcastPrimitive(this.primitives[id]);
    };
    this.viewerApi.drawLine = (id: string, points: unknown[], color = 0xff0000) => {
      this.primitives[id] = { type: "line", id, points, color };
      this.broadcastPrimitive(this.primitives[id]);
    };
    this.viewerApi.drawPoints = (id: string, points: unknown[], color = 0xff0000, size = 5) => {
      this.primitives[id] = { type: "points", id, points, color, size };
      this.broadcastPrimitive(this.primitives[id]);
    };
    (this.bot as Bot & { viewer?: BotViewerApi }).viewer = this.viewerApi;
  }

  private broadcastPrimitive(primitive: ViewerPrimitive): void {
    for (const socket of this.sockets) {
      socket.emit("primitive", primitive);
    }
  }

  private readonly handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith(SOCKET_PATH)) {
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const assetPath = normalize(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
    const filePath = join(WATCHER_ROOT, assetPath);
    if (!filePath.startsWith(WATCHER_ROOT)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "forbidden" }));
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        "content-type": contentTypeFor(filePath),
        "cache-control": filePath.endsWith(".json") ? "public, max-age=3600" : "no-cache"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    }
  };
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}
