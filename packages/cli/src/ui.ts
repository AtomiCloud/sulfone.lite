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

export function warn(message: string): string {
  return `${chalk.yellow('[warn]')} ${message}`;
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
