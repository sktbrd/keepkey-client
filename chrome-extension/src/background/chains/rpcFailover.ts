/**
 * EVM RPC failover for read-style calls keyed by networkId.
 *
 * The active-provider failover (`withRpcFailover` in ethereumHandler.ts)
 * iterates the URLs the user is currently connected to. This module
 * covers the *read* sites that resolve a networkId on demand —
 * GET_ASSET_BALANCE, GET_EVM_BALANCE, VALIDATE_ERC20_TOKEN — where the
 * caller passes "give me a working RPC for chain X" rather than "use
 * whatever the user picked".
 *
 * Priority order matches the rest of the codebase:
 *   1. user override (custom RPC from Add Network UI / blockchainDataStorage)
 *   2. Pioneer-discovered URLs (registry.getChainInfo)
 *   3. last-resort hardcoded list (lastResortRpcs)
 *
 * Per-attempt timeout via makeStaticProvider's transport-level config
 * stops a hung URL from stalling the loop.
 */

import type { JsonRpcProvider } from 'ethers';
import { blockchainDataStorage } from '@extension/storage';
import { getChainInfo, makeStaticProvider } from './registry';
import { getLastResortRpcs } from './lastResortRpcs';

const FAILED_RPC_COOLDOWN_MS = 60_000;
// Distinct from ethereumHandler's failedRpcs map. The active-provider
// path and the by-networkId reads have different rate-limit blast
// radii (active provider = current chain only; reads = any chain), so
// keeping the cooldowns independent prevents one slow network from
// blocking the other.
const failedRpcs = new Map<string, number>();

export const isTransientRpcError = (errMsg: string): boolean => {
  const m = errMsg.toLowerCase();
  return (
    m.includes('rate limit') ||
    m.includes('throttle') ||
    m.includes('429') ||
    m.includes('timeout') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('network') ||
    m.includes('server_error') ||
    m.includes('exceeded maximum retry') ||
    /\b5\d{2}\b/.test(m) // 5xx
  );
};

async function buildCandidates(networkId: string): Promise<string[]> {
  const customChain = await blockchainDataStorage.getBlockchainData(networkId);
  const customUrls: string[] =
    customChain?.providers && customChain.providers.length > 0
      ? customChain.providers
      : customChain?.providerUrl
        ? [customChain.providerUrl]
        : [];
  const pioneer = await getChainInfo(networkId);
  const pioneerUrls: string[] = pioneer?.rpcs || [];
  const lastResort = getLastResortRpcs(networkId);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const u of [...customUrls, ...pioneerUrls, ...lastResort]) {
    const t = (u || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      ordered.push(t);
    }
  }
  return ordered;
}

function applyCooldown(candidates: string[]): string[] {
  const now = Date.now();
  for (const [url, failedAt] of failedRpcs) {
    if (now - failedAt >= FAILED_RPC_COOLDOWN_MS) failedRpcs.delete(url);
  }
  const available = candidates.filter(url => {
    const failedAt = failedRpcs.get(url);
    return !(failedAt && now - failedAt < FAILED_RPC_COOLDOWN_MS);
  });
  // If every candidate is cooling, clear and try them all rather than
  // hard-failing — the same convention as ethereumHandler's getProvider.
  if (available.length === 0 && candidates.length > 0) {
    failedRpcs.clear();
    return candidates.slice();
  }
  return available;
}

/**
 * Run an RPC operation with failover across the candidate list for
 * `networkId`. Definitive errors (revert, invalid params) surface
 * immediately. Transient errors (rate limit, 5xx, network, timeout)
 * fail over to the next URL.
 */
export async function withRpcFailoverByNetworkId<T>(
  networkId: string,
  op: (provider: JsonRpcProvider, url: string) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  const candidates = await buildCandidates(networkId);
  const available = applyCooldown(candidates);
  if (available.length === 0) {
    throw new Error(`No RPC URLs available for ${networkId}`);
  }

  const errors: { url: string; error: string }[] = [];
  let lastErr: unknown = null;
  const now = Date.now();
  for (const url of available) {
    try {
      const provider = makeStaticProvider(url, networkId, { timeoutMs: options?.timeoutMs ?? 5000 });
      return await op(provider, url);
    } catch (e: any) {
      const errMsg = String(e?.message || e);
      if (!isTransientRpcError(errMsg)) {
        // Definitive — won't help to try another RPC.
        throw e;
      }
      console.warn(`[rpcFailover] ${networkId} ${url} transient failure, trying next:`, errMsg);
      errors.push({ url, error: errMsg });
      failedRpcs.set(url, now);
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`All ${available.length} RPC endpoints failed for ${networkId}`);
}
