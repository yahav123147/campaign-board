export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installExpressGateAutoApprover } = await import("./orchestrator/gateAutoApprove");
  installExpressGateAutoApprover();
  const { startExecutionWatchdog } = await import("./orchestrator/executionService");
  const recovered = await startExecutionWatchdog();
  if (recovered.failed > 0) {
    console.warn(`[execution watchdog] recovered ${recovered.failed} expired attempts at startup`);
  }
}
