import SafeAppsSDK from "@safe-global/safe-apps-sdk";
import { SafeAppProvider } from "@safe-global/safe-apps-provider";
import { createPublicClient, custom, getAddress, http, isAddress, type Address, type PublicClient } from "viem";

export type Connection =
  | { mode: "safe"; sdk: SafeAppsSDK; client: PublicClient; safe: Address; chainId: number; guard?: Address }
  | { mode: "standalone"; client: PublicClient; safe: Address; rpc: string; guard?: Address }
  | { mode: "unconfigured"; reason?: string };

const SAFE_INFO_TIMEOUT_MS = 1500;

function optionalAddress(value: string | null, name: string): Address | undefined {
  if (value === null || value === "") return undefined;
  if (!isAddress(value, { strict: false })) throw new Error(`invalid ${name} address in URL: ${value}`);
  return getAddress(value);
}

/**
 * Inside a Safe{Wallet} iframe, connects through the Safe Apps SDK. Otherwise reads `?rpc=…&safe=…[&guard=…]` from
 * the URL and runs standalone and read-only (used against the local Anvil demo).
 */
export async function connect(): Promise<Connection> {
  const params = new URLSearchParams(window.location.search);
  let guard: Address | undefined;
  try {
    guard = optionalAddress(params.get("guard"), "guard");
  } catch (error) {
    return { mode: "unconfigured", reason: (error as Error).message };
  }

  if (window.parent !== window) {
    const sdk = new SafeAppsSDK();
    const info = await Promise.race([
      sdk.safe.getInfo(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SAFE_INFO_TIMEOUT_MS)),
    ]);
    if (info) {
      const client = createPublicClient({ transport: custom(new SafeAppProvider(info, sdk)) }) as PublicClient;
      return { mode: "safe", sdk, client, safe: getAddress(info.safeAddress), chainId: info.chainId, guard };
    }
  }

  const rpc = params.get("rpc");
  const safeParam = params.get("safe");
  if (!rpc || !safeParam) return { mode: "unconfigured" };
  try {
    const safe = optionalAddress(safeParam, "safe")!;
    const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
    return { mode: "standalone", client, safe, rpc, guard };
  } catch (error) {
    return { mode: "unconfigured", reason: (error as Error).message };
  }
}
