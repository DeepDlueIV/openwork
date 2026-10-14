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
  Build or change an App: a small interactive view, such as a dashboard, tracker, lookup, form, or calculator, that opens beside the chat and in any MCP Apps host.

  Triggers when the user asks to:
  - build, make, or create an app, dashboard, tracker, calculator, form, or interactive view
  - turn connected data or a Workflow into something they can open again, filter, or click
  - change, fix, or restyle an App they already have
---

# Build an App

An App is a small React view that OpenWork compiles and publishes as its own MCP server. It runs as the person using it, with their own access and connections, and opens again with live data in chat, the side panel, and dashboards.

## Decide first

- Build an App when the person will come back to it or needs inputs, filters, or buttons. When one answer settles the question, answer in chat.
- One App does one job. Name its focal element before writing anything: the list, number, status, or button the person came for.
- A self-contained App, such as a calculator or checklist, binds no tools. Anything that shows or changes the person's data binds the tools it needs.

## Steps

1. Find the data and actions it needs, unless it is self-contained: search_capabilities with 2-4 keyword variants, then pick exact matches that create_app can bind. Prefer tools that only read (readOnly: true). When the data must be combined or computed each time, save a live Workflow first, as execute_capability_script describes.
2. Call prepare_app with a title that names the outcome ("Open Linear issues", not "Dashboard"), one sentence on what the person sees and does, and those exact tools. It verifies them and returns their input schemas and a starter already wired to them.
3. Write the App from that starter. Keep its theme, state handling, and tool calls. Replace the general result view with the focal view, rename buttons to their outcome, and keep only the inputs the person needs.
4. Call create_app with the preparationId, the same tools, the complete React and CSS, and a textFallback of one or two sentences on what the App shows. If it fails, fix exactly what the error names and call create_app again with the same preparationId. Never fall back to a local HTML file, save_artifact_view, or config-object writes.
5. Reply in one or two sentences: what the App shows and one thing to try in it. OpenWork shows the build as it happens and opens the App, so do not narrate the steps, claim stages in prose, or paste the source.

To change an App, keep its purpose and tools unless the person asks otherwise, and follow update_app.

## Starters

prepare_app picks one from the tools you declare. Each is also a resource you can read before you start:

- lookup (${appStarterResourceUri("lookup")}): every tool only reads. It loads on its button, with inputs filled from the launch input. For dashboards, lists, status boards, and search.
- action (${appStarterResourceUri("action")}): at least one tool changes data. Inputs, one primary button that makes one call, the outcome, and a read on its own button.
- standalone (${appStarterResourceUri("standalone")}): no tools. Its logic runs on the inputs and the launch input. For calculators, converters, and planners.

## What a good App looks like

- Its height is its content: the host grows the frame to fit, up to hostContext.containerDimensions.maxHeight. Never set a height, 100vh or 100% on the root, and add no scrolling areas inside; show the top rows and a count rather than everything. No automatic navigation.
- It reads well at every width it opens in: the chat, the side panel and narrow dashboard tiles. Keep the starter's root container (container-type: inline-size) and adapt with @container rules, never viewport units or fixed widths.
- At most two primary actions. The main one sits right after the inputs it uses and spans the width when narrow; anything else is a quiet link.
- The host already shows the App's title, so do not repeat it as a heading or add a paragraph explaining the App. Report state instead: "12 open issues · updated 9:41".
- Every state is designed. Loading keeps the layout with placeholder rows instead of "Loading…". Empty says what to try. An error says what happened and what to do next. Blocked is neutral and says why.
- Buttons name their outcome ("Create invoice", "Find orders") in sentence case. No tool names, ids, or JSON on screen.
- Colors and fonts come from the host theme the starter applies, such as var(--color-text-primary) and var(--color-border-primary), with system colors (CanvasText, Canvas) as fallbacks, so it follows light and dark by itself. No hard-coded colors, gradients, emoji, or decorative badges.
- The launch input fills the App's inputs, so the chat can open it on a specific record.
`
