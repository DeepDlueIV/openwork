import {
  DenAuthError,
  DenRequestError,
  DenUrlError,
  DeviceFlowError,
  FileSafetyError,
  GatewayError,
  PromptError,
  StateError,
} from "../../agent-gateway-core/src/index.ts"
import { assertAllowed, parseArgs } from "./args.ts"
import { login, logout, messageOf, models, setup, status, token, uninstall, type Deps } from "./commands.ts"
import { SELF, UsageError } from "./paths.ts"
import { ProfileConflictError } from "./profile.ts"

export const VERSION = "0.1.0"

export const HELP = `codex-openwork: use your OpenWork organization's AI models in Codex.

Usage: ${SELF} <command> [options]

Commands:
  login       Sign in to OpenWork in your browser.
                --api URL   OpenWork address (default https://api.openworklabs.com)
                --org ID    Organization to use, if you belong to several
                --open      Open the sign-in page in your browser for you
  setup       Set up a Codex profile that uses OpenWork.
                --model ID      Model to use (see "models")
                --profile NAME  Profile name (default openwork)
                --no-mcp        Do not add the OpenWork MCP server to Codex
                --yes           Do not ask for confirmation
                --force         Replace a profile file not created by codex-openwork
  status      Show what is set up. Never shows keys.
  models      List the models Codex can use. --all also lists the others.
  token       Print your AI Gateway key (Codex runs this; you do not need to).
  uninstall   Remove the Codex profile and helper. Keeps your sign-in.
                --profile NAME, --yes
  logout      Sign out and remove your saved sign-in.

After setup, start Codex with: codex --profile openwork
`

const COMMANDS: Readonly<Record<string, { readonly options: readonly string[]; readonly run: (args: ReturnType<typeof parseArgs>, deps: Deps) => Promise<number> }>> = {
  login: { options: ["api", "org", "open"], run: login },
  setup: { options: ["model", "profile", "no-mcp", "yes", "force"], run: setup },
  status: { options: ["profile"], run: status },
  models: { options: ["all"], run: models },
  token: { options: [], run: token },
  uninstall: { options: ["profile", "yes"], run: uninstall },
  logout: { options: [], run: logout },
}

function describe(error: unknown): string {
  if (error instanceof DenAuthError) return `OpenWork no longer accepts your sign-in. Run: ${SELF} login`
  if (
    error instanceof UsageError
    || error instanceof PromptError
    || error instanceof DeviceFlowError
    || error instanceof StateError
    || error instanceof FileSafetyError
    || error instanceof GatewayError
    || error instanceof DenRequestError
    || error instanceof DenUrlError
    || error instanceof ProfileConflictError
  ) return error.message
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "OpenWork did not answer in time. Check your connection and try again."
  }
  if (error instanceof TypeError && error.message === "fetch failed") {
    return "Could not reach OpenWork. Check your connection and try again."
  }
  return `Something went wrong: ${messageOf(error)}`
}

/** Runs one command and returns the process exit code. Errors are printed, never thrown. */
export async function main(argv: readonly string[], deps: Deps): Promise<number> {
  try {
    const args = parseArgs(argv)
    if (args.switches.has("version") && !args.command) {
      deps.stdout.write(`${VERSION}\n`)
      return 0
    }
    if (!args.command || args.command === "help" || args.switches.has("help")) {
      deps.stdout.write(HELP)
      return args.command && args.command !== "help" && !COMMANDS[args.command] ? 1 : 0
    }
    const command = COMMANDS[args.command]
    if (!command) throw new UsageError(`Unknown command "${args.command}". Run ${SELF} help to see the commands.`)
    assertAllowed(args, command.options)
    return await command.run(args, deps)
  } catch (error) {
    deps.stderr.write(`${describe(error)}\n`)
    return 1
  }
}
