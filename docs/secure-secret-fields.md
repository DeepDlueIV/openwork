# Secure keys in chat (`secureSecretFields`, off by default)

An agent sets something up, a tool needs a key to continue, the person types
the key into a private field in the same chat, and the agent carries on. The
key never reaches the model, the transcript or a tool argument.

## Three pieces

1. **Credential prompt** (`packages/types/src/den/credential-prompt.ts`): Den
   tool-result metadata (`credentialPrompt`) naming the saved resource, its
   name and where the key will be sent. The schema is strict and has no value
   field.
2. **Private field** (`apps/app/src/components/secret-field.tsx`,
   `components/chat/credential-prompt-card.tsx`): the app draws it only for
   results from OpenWork Cloud's own tools (direct calls, or calls inside a
   Code Mode script). The value stays out of React state, is masked by default,
   is shown only while typing when the person asks, and is cleared once sent.
   It goes straight to Den using the person's own session. Once it is saved,
   the app continues the run with "I've saved the key. Go ahead.", which
   contains no key.
3. **Human-only writes in Den**: agents (`mcp_internal`), and API keys while
   the flag is on, get `secure_entry_required` if they send a key. They create
   the resource without one and receive the prompt.

This is deliberately not a general secrets engine. Each target writes to
storage that already exists, so turning the flag off restores today's
behaviour unchanged.

## Supported targets

| Target | Save route (people only) | Who can save it |
| --- | --- | --- |
| Shared API key of an org MCP connection | `PUT /v1/mcp-connections/:id/shared-credential` (hidden) | Manage connections |
| Shared API key of an AI Gateway provider (one env key, not LiteLLM) | `PATCH /v1/inference-providers/:id/credential-sets/:setId` | Manage Gateway providers, with a recent sign-in check shown in place |

The MCP route checks the key against the server. A rejected key is not kept,
and provider error text is never echoed or logged, because it can repeat the
key. Marketplace-managed connections are refused. Personal keys already use
the existing member dialog.

## Not in scope here

OAuth client secrets, arbitrary headers, structured or multi-key provider
credentials (AWS, Vertex), LiteLLM, local desktop provider/env secrets, and
plugin/SSO/Slack setup. These keep their existing dashboard forms. Clients
other than OpenWork receive `nextStep` text that points to the dashboard page.

## Proof

`evals/specs/secure-keys-in-chat.e2e.test.ts` runs on engines v1 and v2. It
checks the in-chat field, a rejected key, the saved key reaching the service,
that the key never appears in the page, any model request or Den's log, a
member being refused, the AI Gateway provider, and the rollout turned off.
