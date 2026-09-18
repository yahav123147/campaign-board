import { AsyncLocalStorage } from "node:async_hooks";

export interface ActiveExecutionContext {
  runId: string;
  targetKey: string;
  attemptId: string;
}

const globalForExecutionContext = globalThis as unknown as {
  __councilExecutionContext?: AsyncLocalStorage<ActiveExecutionContext>;
};

const storage = globalForExecutionContext.__councilExecutionContext
  ?? new AsyncLocalStorage<ActiveExecutionContext>();
globalForExecutionContext.__councilExecutionContext = storage;

export function currentExecutionContext(): ActiveExecutionContext | undefined {
  return storage.getStore();
}

export function runInExecutionContext<T>(
  context: ActiveExecutionContext,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run(context, operation);
}
