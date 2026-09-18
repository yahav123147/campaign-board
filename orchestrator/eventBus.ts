import { EventEmitter } from "node:events";
import type { SSEEvent } from "@/types";

type AnySSEHandler = (event: SSEEvent) => void;

class RunEventBus extends EventEmitter {
  private anyHandlers: AnySSEHandler[] = [];

  emit(runId: string, event: SSEEvent): boolean {
    for (const handler of this.anyHandlers) {
      try {
        handler(event);
      } catch {
        // A cross-cutting listener must never break the emitting runner.
      }
    }
    return super.emit(runId, event);
  }

  /** Subscribe to every run's events. Used by cross-cutting policies like express gates. */
  onAny(handler: AnySSEHandler): () => void {
    this.anyHandlers.push(handler);
    return () => {
      this.anyHandlers = this.anyHandlers.filter((h) => h !== handler);
    };
  }

  subscribe(runId: string, handler: (event: SSEEvent) => void): () => void {
    super.on(runId, handler);
    return () => this.off(runId, handler);
  }
}

const globalForBus = globalThis as unknown as { __councilBus?: RunEventBus };
export const eventBus = globalForBus.__councilBus ?? new RunEventBus();
globalForBus.__councilBus = eventBus;
eventBus.setMaxListeners(100);
