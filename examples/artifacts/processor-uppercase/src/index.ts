import type { ProcessorFsHelper, ProcessorInput } from '@cyanprint/sdk';

export async function processor(input: ProcessorInput, fs: ProcessorFsHelper): Promise<void> {
  const files = await fs.read();
  await fs.write(
    files.map(file => (file.content === undefined ? file : { ...file, content: file.content.toUpperCase() })),
  );
}
