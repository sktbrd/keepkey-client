import { describe, it, expect } from 'vitest';
import { bip32ToAddressNList, getDefaultPaths } from './chainConfig';

const HARDENED = 0x80000000;

describe('bip32ToAddressNList', () => {
  it("converts a full hardened+non-hardened path (ETH m/44'/60'/0'/0/0)", () => {
    expect(bip32ToAddressNList("m/44'/60'/0'/0/0")).toEqual([HARDENED + 44, HARDENED + 60, HARDENED + 0, 0, 0]);
  });

  it("treats 'h' and 'H' as hardened, equivalent to the apostrophe", () => {
    expect(bip32ToAddressNList("m/84'/0'/0'")).toEqual(bip32ToAddressNList('m/84h/0h/0h'));
    expect(bip32ToAddressNList('m/84H/0H/0H')).toEqual([HARDENED + 84, HARDENED + 0, HARDENED + 0]);
  });

  it('parses a path without the leading m/', () => {
    expect(bip32ToAddressNList("44'/0'/0'")).toEqual([HARDENED + 44, HARDENED + 0, HARDENED + 0]);
  });

  it('returns an empty list for the master path', () => {
    expect(bip32ToAddressNList('m/')).toEqual([]);
  });

  it('does not harden plain (non-suffixed) indices', () => {
    expect(bip32ToAddressNList('m/0/1/2')).toEqual([0, 1, 2]);
  });
});

describe('getDefaultPaths', () => {
  it('returns a non-empty set of derivation paths', () => {
    expect(getDefaultPaths().length).toBeGreaterThan(0);
  });

  it("includes the standard ETH path m/44'/60'/0'", () => {
    const eth = getDefaultPaths().find(p => p.networks.includes('eip155:1'));
    expect(eth?.addressNList).toEqual([HARDENED + 44, HARDENED + 60, HARDENED + 0]);
  });

  it('maps each BIP standard to the right purpose index for Bitcoin scripts', () => {
    const btc = getDefaultPaths().filter(p => p.networks.includes('bip122:000000000019d6689c085ae165831e93'));
    const purpose = (scriptType: string) => btc.find(p => p.script_type === scriptType)!.addressNList[0] - HARDENED;
    expect(purpose('p2pkh')).toBe(44); // BIP44 legacy
    expect(purpose('p2sh-p2wpkh')).toBe(49); // BIP49 wrapped segwit
    expect(purpose('p2wpkh')).toBe(84); // BIP84 native segwit
  });

  it('keeps addressNListMaster prefixed by the account-level addressNList', () => {
    for (const p of getDefaultPaths()) {
      expect(p.addressNListMaster.length).toBeGreaterThanOrEqual(p.addressNList.length);
      expect(p.addressNListMaster.slice(0, p.addressNList.length)).toEqual(p.addressNList);
    }
  });
});
