import { EventEmitter } from "node:events";
import { ResidentPresentationSource, ResidentPresentationState, ResidentThoughtPresentation } from "@resident/shared";

export const DEFAULT_PRESENTATION_TTL_MS = 6_000;

export interface PublishResidentThoughtInput {
  residentId: string;
  residentName: string;
  text: string;
  ttlMs?: number;
  nowMs?: number;
}

export class ResidentPresentationController extends EventEmitter implements ResidentPresentationSource {
  private thought: ResidentThoughtPresentation | null = null;

  publishThought(input: PublishResidentThoughtInput): ResidentThoughtPresentation | null {
    const text = input.text.trim();
    if (!text) {
      this.clear();
      return null;
    }

    const nowMs = input.nowMs ?? Date.now();
    this.thought = {
      residentId: input.residentId,
      residentName: input.residentName,
      text,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + (input.ttlMs ?? DEFAULT_PRESENTATION_TTL_MS)).toISOString()
    };
    this.emit("update", this.getPresentationState(nowMs));
    return { ...this.thought };
  }

  clear(): void {
    if (!this.thought) {
      return;
    }
    this.thought = null;
    this.emit("update", { thought: null } satisfies ResidentPresentationState);
  }

  getPresentationState(now = Date.now()): ResidentPresentationState {
    if (this.thought && new Date(this.thought.expiresAt).getTime() <= now) {
      this.thought = null;
      this.emit("update", { thought: null } satisfies ResidentPresentationState);
    }

    return {
      thought: this.thought ? { ...this.thought } : null
    };
  }
}
