/** Flags `cascet connect` understands. */
export const CONNECT_FLAGS = ["--allow-any-seller", "--allow-unlimited-budget", "--accept-tool-changes"] as const;

/** A user-facing error: printed as one message, without a stack trace. */
export class CliError extends Error {
  override name = "CliError";
}

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Set<string>;
  help: boolean;
  version: boolean;
}

/** Split argv (without node and script) into a command, positionals and flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (arg.startsWith("-") && arg.length > 1) flags.add(arg);
    else positionals.push(arg);
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags, help, version };
}

/** Throw on flags the command does not know, and on extra positional arguments. */
export function checkArgs(args: ParsedArgs, allowedFlags: readonly string[], maxPositionals: number): void {
  const unknown = [...args.flags].filter(flag => !allowedFlags.includes(flag));
  if (unknown.length > 0) {
    throw new CliError(`unknown option ${unknown.join(", ")} for "cascet ${args.command ?? ""}" (see cascet --help)`);
  }
  if (args.positionals.length > maxPositionals) {
    throw new CliError(`unexpected argument "${args.positionals[maxPositionals]}" for "cascet ${args.command ?? ""}"`);
  }
}
