import { NextRequest } from "next/server";
import { eventBus } from "@/orchestrator/eventBus";
import { ensureRunLoaded } from "@/orchestrator/runRegistry";
import type { SSEEvent } from "@/types";

export const dynamic = "force-dynamic";
const MAX_PENDING_EVENTS = 4_096;
const MAX_PENDING_EVENT_BYTES = 4 * 1024 * 1024;

function snapshotEvents(run: NonNullable<Awaited<ReturnType<typeof ensureRunLoaded>>>): SSEEvent[] {
  const events: SSEEvent[] = [];

  for (const msg of run.messages) {
    events.push({
      type: "agent-completed",
      runId: run.id,
      agentSlug: msg.agentSlug,
      round: msg.round,
      content: msg.content,
      errorMessage: msg.errorMessage,
    });
  }
  if (run.strategyDoc) {
    events.push({ type: "synthesis-completed", runId: run.id, content: run.strategyDoc });
  }
  if (run.stages) {
    events.push({ type: "stages-initialized", runId: run.id, stages: run.stages, pipeline: run.pipeline });
  }
  if (run.status === "approved" && (!run.stages || run.stages.every((stage) => stage.status === "approved"))) {
    events.push({ type: "run-completed", runId: run.id });
  }

  return events;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Subscribe before the potentially asynchronous disk read. Events emitted
  // while the snapshot is loading stay ordered in this buffer, closing the
  // old snapshot-before-subscribe race without replaying any token twice.
  const pendingEvents: SSEEvent[] = [];
  let pendingBytes = 0;
  let pendingOverflow = false;
  let liveSend: ((event: SSEEvent) => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closeStream: (() => void) | undefined;
  let cleanedUp = false;
  const relay = (event: SSEEvent) => {
    if (cleanedUp) return;
    if (liveSend) liveSend(event);
    else {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (
        pendingEvents.length >= MAX_PENDING_EVENTS
        || pendingBytes + bytes > MAX_PENDING_EVENT_BYTES
      ) {
        pendingOverflow = true;
        cleanup();
        return;
      }
      pendingEvents.push(event);
      pendingBytes += bytes;
    }
  };
  const unsubscribe = eventBus.subscribe(id, relay);
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe();
    pendingEvents.length = 0;
    if (heartbeat) clearInterval(heartbeat);
  };
  const onAbort = () => {
    cleanup();
    closeStream?.();
  };
  req.signal.addEventListener("abort", onAbort, { once: true });

  let existingRun: Awaited<ReturnType<typeof ensureRunLoaded>>;
  try {
    existingRun = await ensureRunLoaded(id);
  } catch (error) {
    req.signal.removeEventListener("abort", onAbort);
    cleanup();
    throw error;
  }
  if (!existingRun) {
    req.signal.removeEventListener("abort", onAbort);
    cleanup();
    return Response.json({ error: "Run not found" }, { status: 404 });
  }
  if (pendingOverflow) {
    req.signal.removeEventListener("abort", onAbort);
    cleanup();
    return Response.json(
      { error: "The run changed too quickly while the stream was opening. Reconnect." },
      { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } },
    );
  }

  const initialEvents = snapshotEvents(existingRun);
  const initialEventKeys = new Set(initialEvents.map((event) => JSON.stringify(event)));
  const bufferedEvents = pendingEvents.filter((event) => {
    if (initialEventKeys.has(JSON.stringify(event))) return false;
    // The full persisted stage snapshot is authoritative and at least as new
    // as a stage snapshot emitted while its locked read was in progress.
    if (event.type === "stages-initialized" && existingRun.stages) return false;
    return true;
  });

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const send = (event: SSEEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // controller may have been closed
        }
      };

      for (const event of initialEvents) send(event);
      for (const event of bufferedEvents) send(event);
      pendingEvents.length = 0;
      pendingBytes = 0;
      // No async boundary exists between draining the buffer and installing
      // the live sender, so an event can take exactly one of those paths.
      liveSend = send;

      heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
        catch { cleanup(); }
      }, 15000);

      closeStream = () => {
        try { controller.close(); } catch {}
      };
      if (req.signal.aborted) onAbort();
    },
    cancel() {
      req.signal.removeEventListener("abort", onAbort);
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
