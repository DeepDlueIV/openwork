import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface ProviderConfigTemplateError {
  providerId: string;
  field: string;
  code: "missing_environment_variable" | "unreadable_file_reference";
  message: string;
}

/** V1 substitutes env first, then trimmed UTF-8 file contents relative to the
 * declaring config file. Resolve only referenced values, never forward the
 * server's environment to the native engine or include resolved values in errors.
 * Source: anomalyco/opencode v1.18.30, config/variable.ts.
 */
export async function resolveProviderConfigTemplates(
  providers: Record<string, unknown>,
  options: {
    directory: string;
    environment: ReadonlyMap<string, string>;
    inheritedEnvironment?: NodeJS.ProcessEnv;
    home?: string;
    readText?: (path: string) => Promise<string>;
  },
): Promise<{ providers: Record<string, unknown>; errors: ProviderConfigTemplateError[] }> {
  const errors: ProviderConfigTemplateError[] = [];
  const resolved: Record<string, unknown> = {};
  const inherited = options.inheritedEnvironment ?? process.env;
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  for (const [providerId, provider] of Object.entries(providers)) {
    const before = errors.length;
    const string = async (value: string, field: string): Promise<string> => {
      const expanded = value.replace(/\{env:([^}]+)\}/g, (_token, name: string) => {
        // The managed v1 child explicitly removes this server-only secret.
        const replacement = name === "OPENWORK_ENCRYPTION_KEY" ? undefined : inherited[name] ?? options.environment.get(name);
        if (!replacement) {
          errors.push({ providerId, field, code: "missing_environment_variable", message: `Provider ${providerId}: ${field} references missing environment variable ${name}. Set it in Settings > Environment and apply the changes.` });
        }
        return replacement ?? "";
      });
      let output = "";
      let cursor = 0;
      for (const match of expanded.matchAll(/\{file:([^}]+)\}/g)) {
        output += expanded.slice(cursor, match.index);
        const reference = match[1];
        const path = reference.startsWith("~/") ? join(options.home ?? homedir(), reference.slice(2))
          : isAbsolute(reference) ? reference : resolve(options.directory, reference);
        try { output += (await readText(path)).trim(); }
        catch {
          // File paths can themselves contain substituted credentials. Never
          // expose the path, OS error, contents, or the original template here.
          errors.push({ providerId, field, code: "unreadable_file_reference", message: `Provider ${providerId}: ${field} references a file that could not be read. Check the file reference relative to the provider configuration.` });
        }
        cursor = match.index + match[0].length;
      }
      return output + expanded.slice(cursor);
    };
    const visit = async (value: unknown, field: string): Promise<unknown> => {
      if (typeof value === "string") return string(value, field);
      if (Array.isArray(value)) return Promise.all(value.map((entry, index) => visit(entry, `${field}[${index}]`)));
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [
        await string(key, field), await visit(entry, field ? `${field}.${key}` : key),
      ])));
    };
    const value = await visit(provider, "");
    if (errors.length === before) resolved[providerId] = value;
  }
  return { providers: resolved, errors };
}
