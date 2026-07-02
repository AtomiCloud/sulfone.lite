import chalk from 'chalk';

export class ReportedCliError extends Error {}

export function brand(): string {
  return `${chalk.cyanBright('cyanprint')} ${chalk.dim('v4')}`;
}

export function info(message: string): string {
  return `${chalk.cyan('[info]')} ${message}`;
}

export function success(message: string): string {
  return `${chalk.green('[ok]')} ${message}`;
}

export function failure(message: string): string {
  return `${chalk.red('[error]')} ${message}`;
}

export function pathLabel(value: string): string {
  return chalk.bold(value);
}

export function kv(label: string, value: string | number | boolean | undefined): string {
  return `${chalk.dim(label.padEnd(18))}${value ?? chalk.dim('none')}`;
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printSection(title: string, rows: string[]): void {
  console.log(chalk.bold(title));
  for (const row of rows) {
    console.log(`  ${row}`);
  }
}

/** One live line per generation step: templates flush left, their artifacts indented. */
export function progressLine(event: { kind: string; ref: string; detail?: string }): string {
  if (event.kind === 'template') {
    return `${chalk.cyan('▸')} template ${pathLabel(event.ref)}`;
  }
  const suffix = event.kind === 'resolver' && event.detail ? chalk.dim(` (${event.detail})`) : '';
  return `  ${chalk.dim('•')} ${event.kind} ${event.ref}${suffix}`;
}
