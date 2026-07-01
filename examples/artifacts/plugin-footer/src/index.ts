import type { PluginHelper, PluginInput } from '@cyanprint/sdk';

export async function plugin(input: PluginInput, helper: PluginHelper): Promise<void> {
  const files = await helper.read();
  await helper.write(
    files.map(file =>
      file.content === undefined ? file : { ...file, content: `${file.content}\nGenerated locally.\n` },
    ),
  );
}
