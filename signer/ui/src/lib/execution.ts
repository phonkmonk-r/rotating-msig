import type { DappCall, Execution } from "../api";

/** Whether the app should keep following an execution: still being sent, waiting for a block, or returning gas. */
export function executionInFlight(execution: Pick<Execution, "status" | "sweep">): boolean {
  return execution.status === "preparing" || execution.status === "pending" || execution.status === "stuck" || execution.sweep?.status === "waiting";
}

/** The colour of the execution's checklist. */
export function executionTone(status: Execution["status"]): "ok" | "critical" | "warning" | "pending" {
  if (status === "success") return "ok";
  if (status === "reverted" || status === "failed") return "critical";
  if (status === "stuck" || status === "replaced") return "warning";
  return "pending";
}

/** ETH a dApp request sends in total, in wei. Values arrive as decimal or 0x hex; empty means zero. */
export function requestValue(calls: readonly DappCall[]): bigint {
  return calls.reduce((sum, call) => sum + (call.value && call.value !== "0x" ? BigInt(call.value) : 0n), 0n);
}

/** The button that sends an action this signer starts: a Safe's only signer executes it at once, others propose it. */
export function sendLabel(soleSigner: boolean): string {
  return soleSigner ? "Execute" : "Sign & propose";
}

/** What happens once an action is sent. */
export function nextStep(soleSigner: boolean): string {
  return soleSigner ? "You are the only signer, so it is executing now; follow it on Transactions." : "Another signer executes it from Transactions.";
}

/**
 * The button while an action is being sent. Both kinds first re-check and simulate the transaction; the only signer then
 * starts the execution (nothing is signed until it is sent), others sign their confirmation.
 */
export function sendingLabel(soleSigner: boolean): string {
  return soleSigner ? "Simulating…" : "Signing…";
}

/** What the app is doing while an action is being sent, in a sentence. */
export function sendingNote(soleSigner: boolean): string {
  return soleSigner ? "Simulating the transaction, then sending it from your current key…" : "Simulating the transaction, then signing your confirmation…";
}
