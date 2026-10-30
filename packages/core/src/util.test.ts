import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeText, mapWithConcurrency, stateTimestamp, templateDirIntegrity } from './util';

describe('mapWithConcurrency', () => {
  test('runs up to N tasks concurrently and preserves input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [1, 2, 3, 4, 5, 6];
    const output = await mapWithConcurrency(items, 3, async value => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight -= 1;
      return value * 2;
    });
    expect(output).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxInFlight).toBe(3);
  });

  test('a limit of 1 runs sequentially (never more than one in flight)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 1, async value => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return value;
    });
    expect(maxInFlight).toBe(1);
  });
});

describe('templateDirIntegrity', () => {
  test('ignores the registry cache marker files so differing cache dirs fingerprint alike', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'cyanprint-integrity-'));
    const marked = await mkdtemp(join(tmpdir(), 'cyanprint-integrity-'));
    try {
      for (const dir of [plain, marked]) {
        await mkdir(join(dir, 'template'), { recursive: true });
        await writeFile(join(dir, 'cyan.yaml'), 'name: t\n', 'utf8');
        await writeFile(join(dir, 'template', 'a.txt'), 'a\n', 'utf8');
      }
      await writeFile(join(marked, '.cyan_cache_integrity'), 'sha256:abc', 'utf8');
      await writeFile(join(marked, '.cyan_cache_content_integrity'), 'def', 'utf8');
      expect(await templateDirIntegrity(marked)).toBe(await templateDirIntegrity(plain));
      await writeFile(join(marked, 'template', 'a.txt'), 'b\n', 'utf8');
      expect(await templateDirIntegrity(marked)).not.toBe(await templateDirIntegrity(plain));
    } finally {
      await rm(plain, { recursive: true, force: true });
      await rm(marked, { recursive: true, force: true });
    }
  });
});

describe('stateTimestamp', () => {
  test('honours a valid SOURCE_DATE_EPOCH and warns once about an invalid one', () => {
    const saved = process.env.SOURCE_DATE_EPOCH;
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: unknown) => {
      warnings.push(String(message));
    };
    try {
      process.env.SOURCE_DATE_EPOCH = '1700000000';
      expect(stateTimestamp()).toBe('2023-11-14T22:13:20.000Z');
      expect(warnings).toEqual([]);

      process.env.SOURCE_DATE_EPOCH = 'not-a-number';
      expect(Number.isNaN(Date.parse(stateTimestamp()))).toBe(false);
      stateTimestamp();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('SOURCE_DATE_EPOCH');
    } finally {
      console.warn = warn;
      if (saved === undefined) {
        delete process.env.SOURCE_DATE_EPOCH;
      } else {
        process.env.SOURCE_DATE_EPOCH = saved;
      }
    }
  });
});

describe('decodeText', () => {
  test('keeps a UTF-8 BOM so the text round-trips to the same bytes', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    const text = decodeText(bytes);
    expect(text).toBe('﻿hi');
    expect(Buffer.from(text ?? '', 'utf8').equals(Buffer.from(bytes))).toBe(true);
  });
});
