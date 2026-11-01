/** How a flag is used: a plain switch, or a flag that carries a value ("--flag=value"). */
export type FlagKind = "switch" | "value";

/** Flags `cascet connect` understands. */
export const CONNECT_FLAGS: Readonly<Record<string, FlagKind>> = Object.freeze({
  "--allow-any-seller": "switch",
  "--allow-unlimited-budget": "switch",
  "--accept-tool-changes": "value",
});

/** A user-facing error: printed as one message, without a stack trace. */
export class CliError extends Error {
  override name = "CliError";
}

export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  /**
   * Flags by name. The value is the text after the first "=" ("--flag=value"),
   * or undefined for a bare flag. The values of a flag given several times are
   * joined with ",".
   */
  flags: Map<string, string | undefined>;
  help: boolean;
  version: boolean;
}

/** Split argv (without node and script) into a command, positionals and flags. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | undefined>();
  let help = false;
  let version = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version" || arg === "-v") version = true;
    else if (arg.startsWith("-") && arg.length > 1) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      const value = eq === -1 ? undefined : arg.slice(eq + 1);
      const previous = flags.get(name);
      flags.set(name, previous === undefined ? value : value === undefined ? previous : `${previous},${value}`);
    } else positionals.push(arg);
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags, help, version };
}

/**
 * Throw on flags the command does not know, on a value given to a switch, and
 * on extra positional arguments. A value flag given without a value is left to
 * the command, which knows what to ask for.
 */
export function checkArgs(args: ParsedArgs, allowedFlags: Readonly<Record<string, FlagKind>>, maxPositionals: number): void {
  const unknown = [...args.flags.keys()].filter(flag => !Object.hasOwn(allowedFlags, flag));
  if (unknown.length > 0) {
    throw new CliError(`unknown option ${unknown.join(", ")} for "cascet ${args.command ?? ""}" (see cascet --help)`);
  }
  for (const [flag, value] of args.flags) {
    if (allowedFlags[flag] === "switch" && value !== undefined) {
      throw new CliError(`${flag} does not take a value (got "${flag}=${value.slice(0, 40)}")`);
    }
  }
  if (args.positionals.length > maxPositionals) {
    throw new CliError(`unexpected argument "${args.positionals[maxPositionals]}" for "cascet ${args.command ?? ""}"`);
  }
}
