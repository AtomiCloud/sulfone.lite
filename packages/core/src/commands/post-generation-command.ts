export type CommandResult = {
  command: string;
  allowed: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

export async function runPostGenerationCommand(intent: {
  command: string;
  args?: string[];
  allow?: boolean;
  cwd?: string;
}): Promise<CommandResult> {
  if (!intent.allow) {
    return { command: intent.command, allowed: false, stderr: 'Post-generation commands require explicit allow.' };
  }
  const proc = Bun.spawn([intent.command, ...(intent.args ?? [])], {
    cwd: intent.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { command: intent.command, allowed: true, exitCode, stdout, stderr };
}
