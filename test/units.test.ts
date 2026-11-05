import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, generateCode, isValidCode, normaliseCode } from '../src/lib/codes';
import { csvCell, parseCsv } from '../src/lib/csv';
import { parseGuestCsv } from '../src/lib/import';
import { cleanBlock, cleanLine } from '../src/lib/text';

describe('invite codes', () => {
  it('uses an alphabet without ambiguous characters', () => {
    for (const ch of '0O1IL') expect(CODE_ALPHABET).not.toContain(ch);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
  });

  it('generates codes of the requested length from the alphabet only', () => {
    for (const length of [5, 6]) {
      for (let i = 0; i < 500; i++) {
        const code = generateCode(length);
        expect(code).toHaveLength(length);
        expect(code).toMatch(new RegExp(`^[${CODE_ALPHABET}]+$`));
        expect(isValidCode(code)).toBe(true);
      }
    }
  });

  it('is effectively unique and roughly uniform', () => {
    const codes = Array.from({ length: 5000 }, () => generateCode(6));
    expect(new Set(codes).size).toBe(codes.length);
    const counts = new Map<string, number>();
    for (const c of codes.join('')) counts.set(c, (counts.get(c) ?? 0) + 1);
    const expected = (5000 * 6) / 31;
    for (const ch of CODE_ALPHABET) {
      // Rejection sampling: no symbol should be wildly over- or under-represented.
      expect(counts.get(ch)!).toBeGreaterThan(expected * 0.8);
      expect(counts.get(ch)!).toBeLessThan(expected * 1.2);
    }
  });

  it('rejects bad lengths', () => {
    expect(() => generateCode(4)).toThrow();
    expect(() => generateCode(9)).toThrow();
  });

  it('normalises what guests type, but never strips other junk', () => {
    expect(normaliseCode(' ab c-23 ')).toBe('ABC23');
    expect(isValidCode(normaliseCode('abc.23'))).toBe(false);
    expect(isValidCode('ABC0O')).toBe(false);
    expect(normaliseCode(42)).toBe('');
  });
});

describe('CSV', () => {
  it('parses quotes, escaped quotes, CRLF and a BOM', () => {
    const rows = parseCsv('\uFEFFa,"b, c","say ""hi"""\r\n1,2,3\n');
    expect(rows).toEqual([
      ['a', 'b, c', 'say "hi"'],
      ['1', '2', '3'],
    ]);
  });

  it('rejects an unclosed quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow();
  });

  it('defuses spreadsheet formulas on export', () => {
    for (const bad of ['=1+1', '+cmd', '-2', '@SUM(A1)']) expect(csvCell(bad)).toBe(`"'${bad}"`);
    expect(csvCell('Ann "Jo" Example')).toBe('"Ann ""Jo"" Example"');
  });
});

describe('guest import validation', () => {
  const header = 'household,guest,plus_one,max_party_size,evening';

  it('groups rows by household and defaults the cap', () => {
    const r = parseGuestCsv(`${header}\nA,One,yes,,\nA,Two,no,,\nB,Three,,,`, {
      eveningEnabled: false,
    });
    expect(r.errors).toEqual([]);
    expect(r.households.map((h) => [h.household_name, h.max_party_size, h.guests.length])).toEqual([
      ['A', 3, 2],
      ['B', 1, 1],
    ]);
  });

  it('accepts friendly header names', () => {
    const r = parseGuestCsv('Household Name,Guest Name,Plus One\nA,One,y', {
      eveningEnabled: false,
    });
    expect(r.errors).toEqual([]);
    expect(r.households[0]!.guests[0]!.allows_plus_one).toBe(true);
  });

  it('reports each problem with its row number', () => {
    const r = parseGuestCsv(
      `${header}\nA,,no,,\n,Two,no,,\nC,Three,maybe,,\nD,Four,no,0,\nE,Five,no,1,\nE,Six,no,2,\nF,Dup,no,,\nF,dup,no,,`,
      { eveningEnabled: false },
    );
    expect(r.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 8]);
    expect(r.households).toEqual([]);
  });

  it('requires the header columns', () => {
    expect(parseGuestCsv('name,email\nA,b', { eveningEnabled: false }).errors[0]!.line).toBe(1);
  });
});

describe('text sanitising', () => {
  it('strips control and bidi characters and collapses whitespace', () => {
    expect(cleanLine('  Ann\u0000\u202E  Example\n', 40)).toBe('Ann Example');
    expect(cleanBlock('Line one\r\n\r\n\r\n\r\nLine two\u0007', 100)).toBe('Line one\n\nLine two');
  });

  it('enforces length limits by characters, not bytes', () => {
    expect(cleanLine('é'.repeat(10), 10)).toBe('é'.repeat(10));
    expect(cleanLine('x'.repeat(11), 10)).toBeNull();
  });
});

describe('rate-limit identity', () => {
  it('groups IPv6 by /64 and keeps IPv4 as-is', async () => {
    const { rateLimitKey } = await import('../src/lib/identity');
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });
});
