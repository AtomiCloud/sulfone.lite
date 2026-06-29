import { describe, expect, test } from 'bun:test';
import { readTemplateTarFiles, validateTemplateTarPayload } from './archive';
import { parseCyanManifest } from './manifest';
import { artifactVersionId } from './registry';

describe('manifest and cyan script contracts', () => {
  test('manifest accepts author-time dependency declarations without versions', () => {
    const parsed = parseCyanManifest({
      cyanprint: 4,
      kind: 'template',
      name: 'demo',
      bundledEntry: 'cyan.ts',
      processors: ['cyanprint/uppercase'],
      legacy: { docker: { image: 'old' } },
    });
    expect(parsed.manifest.processors[0]).toMatchObject({ kind: 'processor', owner: 'cyanprint', name: 'uppercase' });
    expect(parsed.manifest.processors[0]?.version).toBeUndefined();
    expect(parsed.warnings[0]?.code).toBe('legacy_docker_ignored');
  });

  test('manifest rejects generic object dependency declarations', () => {
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'demo',
        bundledEntry: 'cyan.ts',
        dependencies: [{ kind: 'processor', owner: 'cyanprint', name: 'uppercase' }],
      }),
    ).toThrow('cyan.yaml is invalid');
  });

  test('manifest rejects non-canonical dependency versions', () => {
    expect(() =>
      parseCyanManifest({
        cyanprint: 4,
        kind: 'template',
        name: 'demo',
        bundledEntry: 'cyan.ts',
        processors: ['cyanprint/uppercase@04'],
      }),
    ).toThrow('cyan.yaml is invalid');
  });
});

describe('registry identity contracts', () => {
  test('artifact version ids are collision-free for escaped punctuation', () => {
    expect(artifactVersionId('template', 'cyanprint', 'a-b', '4')).not.toBe(
      artifactVersionId('template', 'cyanprint', 'a_b', '4'),
    );
  });
});

describe('template archive contracts', () => {
  test('reads regular tar files and rejects links', () => {
    const archive = makeTar([
      { path: 'template/README.md', type: '0', content: '# Hi\n' },
      { path: 'assets', type: '5' },
    ]);
    expect(readTemplateTarFiles(archive).map(file => [file.path, new TextDecoder().decode(file.bytes)])).toEqual([
      ['template/README.md', '# Hi\n'],
    ]);

    const symlinkArchive = makeTar([
      { path: 'link', type: '2', linkName: '..' },
      { path: 'link/pwn.txt', type: '0', content: 'bad' },
    ]);
    expect(validateTemplateTarPayload(symlinkArchive)).toContain('unsupported entry type');
  });
});

type TarEntry = {
  path: string;
  type: '0' | '2' | '5';
  content?: string;
  linkName?: string;
};

function makeTar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const content = new TextEncoder().encode(entry.content ?? '');
    const header = new Uint8Array(512);
    writeTarString(header, 0, 100, entry.path);
    writeTarString(header, 100, 8, '0000644');
    writeTarString(header, 108, 8, '0000000');
    writeTarString(header, 116, 8, '0000000');
    writeTarString(
      header,
      124,
      12,
      entry.type === '0' ? content.byteLength.toString(8).padStart(11, '0') : '00000000000',
    );
    writeTarString(header, 136, 12, '00000000000');
    header.fill(32, 148, 156);
    header[156] = entry.type.charCodeAt(0);
    if (entry.linkName) {
      writeTarString(header, 157, 100, entry.linkName);
    }
    writeTarString(header, 257, 6, 'ustar');
    writeTarString(header, 263, 2, '00');
    const checksum = header
      .reduce((sum, byte) => sum + byte, 0)
      .toString(8)
      .padStart(6, '0');
    writeTarString(header, 148, 8, `${checksum}\0 `);
    chunks.push(header);
    if (entry.type === '0') {
      chunks.push(content);
      const padding = (512 - (content.byteLength % 512)) % 512;
      if (padding > 0) {
        chunks.push(new Uint8Array(padding));
      }
    }
  }
  chunks.push(new Uint8Array(1024));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(new TextEncoder().encode(value).slice(0, length), offset);
}
