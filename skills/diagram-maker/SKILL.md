---
name: diagram-maker
description: Create SVG/HTML or Excalidraw diagrams for concepts, architecture, flows, and whiteboards.
metadata: { "openclaw": { "emoji": "🧭" } }
---

# Diagram Maker

Create diagrams as artifacts, not prose. Choose one output mode:

- `clean-svg`: educational concepts, physical systems, processes, lifecycle, simple data flow.
- `architecture-svg`: software/cloud/infra topology, services, databases, queues, trust zones.
- `excalidraw`: editable hand-drawn whiteboard, flowchart, sequence, architecture sketch.

Routing

- User wants editable/collaborative: choose Excalidraw.
- User wants polished standalone browser output: choose SVG/HTML.
- Software architecture with infra components: choose architecture SVG.
- Science, product, process, concept map, physical object: choose clean SVG.
- Unsure: ask one short question only if output format matters; otherwise choose clean SVG.

Default visual style

- Default to dark mode for every new diagram unless the user explicitly asks for light mode or print-first output.
- Use a real dark background, not transparent SVGs that render white in viewers.
- Use high-contrast text: near-white titles, slate body text, and readable labels.
- Use semantic accent colors on dark fills: blue for input/external, green for inventory/state, amber for processing/attention, red for risk/urgent.
- Avoid neon, glows, gradients, and decorative effects. Dark mode should look operational, not arcade.
- Before claiming a diagram is dark, verify the rendered artifact or exported pixels. Source CSS is not proof.
- For Forgejo/Gitea Markdown embeds, prefer dark PNG exports or SVGs with inline colors; do not rely on SVG class CSS rendering correctly in the web UI.

Workflow

1. Extract nodes, groups, labels, and directed relationships.
2. Pick layout first: left-to-right, top-down, hub-spoke, swimlanes, layered stack, sequence.
3. Keep labels short. Prefer 5-9 main elements over dense diagrams.
4. Generate the file at the requested path, or `./diagram.html` / `./diagram.excalidraw`.
5. Verify syntax by opening/parsing when feasible.

SVG/HTML rules

- Single standalone `.html` file with inline CSS and inline SVG.
- No external fonts, JS, images, gradients, glows, decorative blobs, or remote assets.
- Use semantic colors, not rainbow sequences: neutral, input, process, storage, external, risk.
- Draw connectors before nodes so arrows sit behind boxes.
- Every connector path has `fill="none"` and a marker arrow when directed.
- Leave 24px text padding inside boxes; do not let text touch borders.
- Legend only when symbols/colors are not obvious.

SVG template

Use `references/svg-template.md` as the wrapper and replace `<!-- SVG -->`.

Excalidraw rules

- Save `.excalidraw` JSON with `type`, `version`, `source`, `elements`, and `appState`.
- Use bound text for shape labels. Do not use a nonstandard `label` property.
- Keep bound text immediately after its container in the elements array.
- Minimum labeled shape: 120x60. Minimum body text: 16px.
- Use roughness `1`, `fontFamily: 1`, and simple fills.

For exact Excalidraw element snippets, read `references/excalidraw-patterns.md`.
