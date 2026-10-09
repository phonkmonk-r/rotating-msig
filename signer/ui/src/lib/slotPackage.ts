/**
 * The signer address and slot a pasted slot package claims, read without verifying it, so the owner can confirm the
 * address with the newcomer; the session verifies the signature and proofs before anything is signed.
 */
export function packagePreview(code: string): { operator: string; slotId: number } | undefined {
  const text = code.trim();
  if (!text.startsWith("rotation-slot:")) return undefined;
  try {
    const json = atob(text.slice("rotation-slot:".length).replace(/-/g, "+").replace(/_/g, "/"));
    const pkg = JSON.parse(json) as { operator?: unknown; slotId?: unknown };
    return typeof pkg.operator === "string" && typeof pkg.slotId === "number" ? { operator: pkg.operator, slotId: pkg.slotId } : undefined;
  } catch {
    return undefined;
  }
}
