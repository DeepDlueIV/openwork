/**
 * Minimal terminal prompts. Without a TTY, a prompt returns its default or
 * throws PromptError telling the caller which flag to pass instead.
 */
import { createInterface } from "node:readline/promises"

export interface PromptStreams {
  readonly input?: NodeJS.ReadableStream & { readonly isTTY?: boolean }
  readonly output?: NodeJS.WritableStream & { readonly isTTY?: boolean }
}

export class PromptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PromptError"
  }
}

export function isInteractive(streams: PromptStreams = {}): boolean {
  const input = streams.input ?? process.stdin
  const output = streams.output ?? process.stdout
  return input.isTTY === true && output.isTTY === true
}

async function ask(question: string, streams: PromptStreams): Promise<string> {
  const rl = createInterface({ input: streams.input ?? process.stdin, output: streams.output ?? process.stdout, terminal: true })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Yes/no question. `hint` names the non-interactive alternative, e.g. "pass --yes". */
export async function confirm(
  question: string,
  options: PromptStreams & { defaultValue?: boolean; hint?: string } = {},
): Promise<boolean> {
  if (!isInteractive(options)) {
    if (options.defaultValue !== undefined) return options.defaultValue
    throw new PromptError(`Cannot ask "${question}" without a terminal${options.hint ? `; ${options.hint}` : ""}.`)
  }
  const suffix = options.defaultValue === true ? " [Y/n] " : options.defaultValue === false ? " [y/N] " : " [y/n] "
  for (;;) {
    const answer = (await ask(`${question}${suffix}`, options)).toLowerCase()
    if (!answer && options.defaultValue !== undefined) return options.defaultValue
    if (answer === "y" || answer === "yes") return true
    if (answer === "n" || answer === "no") return false
  }
}

export interface Choice<T> {
  readonly label: string
  readonly value: T
}

/** Pick one entry from a numbered list. `defaultIndex` is 0-based. */
export async function pick<T>(
  question: string,
  choices: readonly Choice<T>[],
  options: PromptStreams & { defaultIndex?: number; hint?: string } = {},
): Promise<T> {
  if (choices.length === 0) throw new PromptError("There is nothing to choose from.")
  const defaultChoice = options.defaultIndex === undefined ? undefined : choices[options.defaultIndex]
  if (choices.length === 1) return choices[0].value
  if (!isInteractive(options)) {
    if (defaultChoice) return defaultChoice.value
    throw new PromptError(`Cannot ask "${question}" without a terminal${options.hint ? `; ${options.hint}` : ""}.`)
  }
  const output = options.output ?? process.stdout
  output.write(`${question}\n`)
  choices.forEach((choice, index) => {
    output.write(`  ${index + 1}) ${choice.label}${choice === defaultChoice ? " (default)" : ""}\n`)
  })
  for (;;) {
    const answer = await ask(defaultChoice ? `Choose 1-${choices.length} [${(options.defaultIndex ?? 0) + 1}]: ` : `Choose 1-${choices.length}: `, options)
    if (!answer && defaultChoice) return defaultChoice.value
    const index = /^\d+$/.test(answer) ? Number(answer) - 1 : -1
    const choice = choices[index]
    if (choice) return choice.value
  }
}
