import { describe, it, expect, vi, beforeEach } from 'vitest';

// rpcFailover imports three workspace/sibling modules. Mock them so the unit
// under test runs in node without pulling the storage/polyfill chain. The
// `op` callback we pass into withRpcFailoverByNetworkId is fully under our
// control, so we drive success/failure per URL from the test itself.
const getBlockchainData = vi.fn();
const getChainInfo = vi.fn();
const getLastResortRpcs = vi.fn();

vi.mock('@extension/storage', () => ({
  blockchainDataStorage: { getBlockchainData: (...a: unknown[]) => getBlockchainData(...a) },
}));
vi.mock('./registry', () => ({
  getChainInfo: (...a: unknown[]) => getChainInfo(...a),
  // makeStaticProvider just needs to return an identifiable stub; the test's
  // `op` receives (provider, url) and keys its behavior off `url`.
  makeStaticProvider: (url: string) => ({ __url: url }),
}));
vi.mock('./lastResortRpcs', () => ({
  getLastResortRpcs: (...a: unknown[]) => getLastResortRpcs(...a),
}));

import { withRpcFailoverByNetworkId, isTransientRpcError } from './rpcFailover';

describe('isTransientRpcError', () => {
  it('classifies rate-limit / throttle / 429 as transient', () => {
    expect(isTransientRpcError('rate limit exceeded')).toBe(true);
    expect(isTransientRpcError('Request throttled')).toBe(true);
    expect(isTransientRpcError('HTTP 429 Too Many Requests')).toBe(true);
  });

  it('classifies timeouts and connection resets as transient', () => {
    expect(isTransientRpcError('timeout of 5000ms exceeded')).toBe(true);
    expect(isTransientRpcError('ECONNRESET')).toBe(true);
    expect(isTransientRpcError('ETIMEDOUT')).toBe(true);
  });

  it('classifies 5xx server errors as transient', () => {
    expect(isTransientRpcError('Bad Gateway 502')).toBe(true);
    expect(isTransientRpcError('503 Service Unavailable')).toBe(true);
  });

  it('treats definitive RPC errors (revert / invalid params) as NOT transient', () => {
    expect(isTransientRpcError('execution reverted')).toBe(false);
    expect(isTransientRpcError('invalid params')).toBe(false);
    expect(isTransientRpcError('nonce too low')).toBe(false);
  });
});

describe('withRpcFailoverByNetworkId', () => {
  // Use a fresh networkId + URLs per test so the module-level cooldown map
  // never bleeds between cases.
  beforeEach(() => {
    vi.clearAllMocks();
    getBlockchainData.mockResolvedValue(null);
    getChainInfo.mockResolvedValue(null);
    getLastResortRpcs.mockReturnValue([]);
  });

  it('returns the result from the first working URL', async () => {
    getChainInfo.mockResolvedValue({ rpcs: ['https://a.test/1', 'https://b.test/1'] });
    const op = vi.fn().mockResolvedValue('ok');
    const result = await withRpcFailoverByNetworkId('eip155:test1', op);
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('fails over to the next URL on a transient error', async () => {
    getChainInfo.mockResolvedValue({ rpcs: ['https://a.test/2', 'https://b.test/2'] });
    const op = vi.fn(async (_p: unknown, url: string) => {
      if (url.includes('a.test')) throw new Error('rate limit exceeded');
      return 'second';
    });
    const result = await withRpcFailoverByNetworkId('eip155:test2', op);
    expect(result).toBe('second');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does NOT fail over on a definitive error — it rethrows immediately', async () => {
    getChainInfo.mockResolvedValue({ rpcs: ['https://a.test/3', 'https://b.test/3'] });
    const op = vi.fn(async () => {
      throw new Error('execution reverted');
    });
    await expect(withRpcFailoverByNetworkId('eip155:test3', op)).rejects.toThrow(/reverted/);
    expect(op).toHaveBeenCalledTimes(1); // second URL never tried
  });

  it('throws after every candidate fails transiently', async () => {
    getChainInfo.mockResolvedValue({ rpcs: ['https://a.test/4', 'https://b.test/4'] });
    const op = vi.fn(async () => {
      throw new Error('503 server_error');
    });
    await expect(withRpcFailoverByNetworkId('eip155:test4', op)).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('throws when there are no candidate URLs at all', async () => {
    const op = vi.fn();
    await expect(withRpcFailoverByNetworkId('eip155:test5', op)).rejects.toThrow(/No RPC URLs available/);
    expect(op).not.toHaveBeenCalled();
  });

  it('orders candidates custom-first, then pioneer, then last-resort, deduped', async () => {
    getBlockchainData.mockResolvedValue({ providers: ['https://custom.test', 'https://shared.test'] });
    getChainInfo.mockResolvedValue({ rpcs: ['https://shared.test', 'https://pioneer.test'] });
    getLastResortRpcs.mockReturnValue(['https://lastresort.test']);
    const seen: string[] = [];
    const op = vi.fn(async (_p: unknown, url: string) => {
      seen.push(url);
      throw new Error('timeout'); // force it to walk the whole list
    });
    await expect(withRpcFailoverByNetworkId('eip155:test6', op)).rejects.toThrow();
    expect(seen).toEqual([
      'https://custom.test',
      'https://shared.test', // deduped — appears once despite being in both lists
      'https://pioneer.test',
      'https://lastresort.test',
    ]);
  });
});
