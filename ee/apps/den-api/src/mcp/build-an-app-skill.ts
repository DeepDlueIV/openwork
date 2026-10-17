import { appStarterResourceUri } from "./app-authoring-starter.js"

export const BUILTIN_BUILD_AN_APP_CAPABILITY = "skill:build-an-app"

/**
 * The one place agents learn how OpenWork builds Apps: when to build one, the
 * order of calls, and what a good App looks like. Server instructions only
 * route here, and create_app's description owns the source and tool-call
 * rules the compiler and host enforce, so neither is repeated below.
 */
export const BUILD_AN_APP_SKILL_SOURCE = `---
name: build-an-app
description: |
  Required before any prepare_app, create_app, read_app, or update_app call. Build or change an App: a small interactive view, such as a dashboard, tracker, lookup, form, or calculator, that opens beside the chat and in any MCP Apps host.

  Triggers when the user asks to:
  - build, make, or create an app, dashboard, tracker, calculator, form, or interactive view
  - turn connected data or a Workflow into something they can open again, filter, or click
  - change, fix, or restyle an App they already have
---

# Build an App

An App is a small React view that OpenWork compiles and publishes as its own MCP server. It runs as the person using it, with their own access and connections, and opens again with live data in chat, the side panel, and dashboards.

Follow these steps exactly. A good App takes four calls: search, prepare, create, reply. Do not explore, ask about flags, or look for other builders.

## Decide first

- Build an App when the person will come back to it or needs inputs, filters, or buttons. When one answer settles the question, answer in chat instead.
- One App does one job. Name its focal element before writing anything: the list, number, status, or button the person came for.
- A self-contained App, such as a calculator or checklist, binds no tools: skip step 1. Anything that shows or changes the person's data binds the tools it needs.

## Steps

1. **Find the tools.** Call search_capabilities once with 2-4 keyword variants of the data and action, such as { "query": "linear issues list assigned", "type": "mcp" }. Pick exact matches. Prefer ones that only read (readOnly: true): the App loads them as it opens. When the data must be combined or computed on every open, save a live Workflow first, as execute_capability_script describes, and bind that.
2. **Prepare.** Call prepare_app with a title that names the outcome ("Open Linear issues", not "Dashboard"), one sentence on what the person sees and does, and those tools. It verifies them and returns their input schemas, a preparationId, and a starter already wired to them.
3. **Write from the starter.** Keep its theme, state components, and tool calls. Only change what nextSteps names: the focal view, button labels, and inputs. Never start from a blank file.
4. **Create.** Call create_app with the preparationId, the same title and tools, the complete reactSource and cssSource, and a textFallback of one or two sentences on what the App shows. If it fails, fix exactly what the error names and call create_app again with the same preparationId. Never fall back to a local HTML file, save_artifact_view, or config-object writes.
5. **Reply** in one or two sentences: what the App shows and one thing to try in it. OpenWork shows the build and opens the App, so do not narrate the steps, claim stages, or paste the source.

## Example

The person asks: "Make me a dashboard of my open Linear issues."

1. search_capabilities { "query": "linear issues list assigned open", "type": "mcp", "limit": 5 } returns a match such as linear.list_issues (readOnly: true). Use the exact capability string it returns.
2. prepare_app:

   { "title": "My open Linear issues", "description": "Shows the person's open Linear issues, newest first, with a refresh button.", "tools": [{ "name": "list_issues", "description": "List the person's open issues.", "capability": "linear.list_issues" }] }

   It returns the lookup starter: it calls list_issues as it opens and shows its result.
3. In the starter, replace ResultView with a list of the top 10 issues (identifier, title, state) and a line such as "23 open · updated 9:41". Rename the button to "Refresh issues". Leave useTheme, useToolCall, and the loading, empty, and error states as they are.
4. create_app with that preparationId, the same title and tools, the edited reactSource, the starter's cssSource, and "textFallback": "Your open Linear issues, newest first."
5. Reply: "Your open Linear issues are on the board. Try Refresh issues after you close one."

A calculator ("a tip calculator") skips search: prepare_app with no tools returns the standalone starter. Replace FIELDS and compute() with the bill, tip percentage, and people, then create_app.

## Change an App

Call read_app with its appId, keep its purpose and tools unless the person asks otherwise, change only what they asked, and call update_app with read_app's revisionId as expectedRevisionId.

## Starters

prepare_app picks one from the tools you declare. Each is also a resource you can read before you start:

- lookup (${appStarterResourceUri("lookup")}): every tool only reads. It loads on open and on its button. For dashboards, lists, status boards, and search.
- action (${appStarterResourceUri("action")}): at least one tool changes data. Inputs, one primary button that makes one call, the outcome, and a read that refreshes after it.
- standalone (${appStarterResourceUri("standalone")}): no tools. Its logic runs on the inputs and the launch input. For calculators, converters, and planners.

## What a good App looks like

- It fits in one scroll of the reply: no internal scrolling, no automatic navigation, and at most two primary actions. Show the top rows and a count rather than everything.
- The host already shows the App's title, so do not repeat it as a heading or add a paragraph explaining the App. Report state instead: "12 open issues · updated 9:41".
- Every state is designed. Loading keeps the layout with placeholder rows instead of "Loading…". Empty says what to try. An error says what happened and what to do next. Blocked is neutral and says why.
- Buttons name their outcome ("Create invoice", "Find orders") in sentence case. No tool names, ids, or JSON on screen.
- Colors come from the host theme the starter applies, such as var(--color-text-primary) and var(--color-border-primary). No hard-coded black or white, gradients, emoji, or decorative badges.
- The launch input fills the App's inputs, so the chat can open it on a specific record.
`
