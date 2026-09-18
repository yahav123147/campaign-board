import type { SSEEvent } from "@/types";

export function subscribeToRun(
  runId: string,
  onEvent: (event: SSEEvent) => void,
  onError?: (err: Error) => void
): () => void {
  const es = new EventSource(`/api/runs/${runId}/stream`);

  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data) as SSEEvent;
      onEvent(event);
    } catch (e) {
      console.error("Failed to parse SSE event:", e);
    }
  };

  es.onerror = () => {
    onError?.(new Error("SSE connection error"));
  };

  return () => es.close();
}
