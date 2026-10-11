import { UsageError } from "./paths.ts"

const VALUE_FLAGS = new Set(["api", "org", "model", "profile"])
const BOOLEAN_FLAGS = new Set(["open", "no-mcp", "yes", "force", "all", "help", "version"])
const SHORT_FLAGS: Readonly<Record<string, string>> = { "-y": "yes", "-h": "help", "-v": "version" }

export interface ParsedArgs {
  readonly command: string | null
  readonly values: ReadonlyMap<string, string>
  readonly switches: ReadonlySet<string>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: string | null = null
  const values = new Map<string, string>()
  const switches = new Set<string>()
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    const short = SHORT_FLAGS[arg]
    if (short) {
      switches.add(short)
      continue
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=")
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++index] : arg.slice(eq + 1)
        if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
          throw new UsageError(`--${name} needs a value.`)
        }
        values.set(name, value)
        continue
      }
      if (BOOLEAN_FLAGS.has(name) && eq === -1) {
        switches.add(name)
        continue
      }
      throw new UsageError(`Unknown option ${eq === -1 ? arg : arg.slice(0, eq)}.`)
    }
    if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`)
    if (command === null) {
      command = arg
      continue
    }
    throw new UsageError(`Unexpected argument "${arg}".`)
  }
  return { command, values, switches }
}

/** Rejects options that do not apply to the command, so typos are not silently ignored. */
export function assertAllowed(args: ParsedArgs, allowed: readonly string[]): void {
  const permitted = new Set([...allowed, "help"])
  for (const name of [...args.values.keys(), ...args.switches]) {
    if (!permitted.has(name)) throw new UsageError(`--${name} does not apply to "${args.command ?? ""}".`)
  }
}
