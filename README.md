# Constellation Graph

A fluid, slowly orbiting 3D map of your notes for [Obsidian](https://obsidian.md). Notes glow as points of light, coloured by folder (or tag). Clusters swirl around their own centres and drift past one another, like a screensaver for your vault, while the camera slowly circles. Everything is built to stay usable: full keyboard control, screen-reader announcements, a searchable note list, a colour-blind-safe palette, a high-contrast mode, and no motion at all if your system asks for reduced motion.

> Status: pre-release (0.1.0). Not yet in the community plugin directory.

## Use

- Ribbon icon (orbit) or the command **Open constellation graph**.
- It updates live as you add, remove, rename and link notes. Your selection and any hidden groups are kept.

### Mouse

| Action | Result |
|---|---|
| Drag | Orbit |
| Scroll | Zoom |
| Click a note | Select it and fly to it |
| Drag a note | It follows your pointer, its linked notes are tugged along, and on release everything springs back into place with a small bounce |
| Double-click, or Ctrl/Cmd+click | Open the note (Ctrl/Cmd+click opens a new tab) |
| Click empty space | Deselect |

### Toolbar

| Button | What it does |
|---|---|
| Search | Highlights matching notes and lists them |
| Pause / play | Stops or resumes all motion |
| Reset view | Frames the whole graph again |
| **Animate** | A timelapse: every note disappears, then returns in the order it was created, and each link flashes as it forms. Press again to stop |
| **Supernova** | Everything is crushed into a point, detonates in one soft flash, re-forms from scratch, and a wave of light then runs outward along the shortest paths from the most-connected note (or the note you have selected). Press again to stop |
| Note list | A searchable list of notes, an alternative to the canvas |
| Help | Keyboard shortcuts |

### Keyboard

The graph area is focusable. Press **?** for this list in the app.

| Key | Action |
|---|---|
| Left / Right | Previous / next note |
| Up / Down | Step through the selected note's connections |
| Enter (Shift+Enter) | Open the selected note (in a new tab) |
| Space | Pause or resume motion |
| A | Animate (timelapse) |
| N | Supernova |
| R | Reset the view |
| L | Show or hide the note list |
| / | Focus search |
| Esc | Clear selection, close a panel |

### Accessibility

- **Reduced motion.** If your operating system requests reduced motion, flow, orbiting and camera flights are turned off: the layout settles once and stays still, dragged notes return at once instead of bouncing, and Supernova just recomputes the layout instantly without the show. Animate still works because you asked for it, but without the pop-in effects. You can also set motion to *Off* yourself, or pause at any time.
- **No strobing.** The Supernova has a single soft flash that fades over about a second, and it is skipped under reduced motion and in high-contrast mode.
- **Screen readers.** The canvas is hidden from assistive technology and replaced by a status region that announces the selected note, its group and link count. The note list, search, group legend and details panel are ordinary buttons and lists.
- **No colour-only meaning.** Group names are always shown in the legend, tooltip and details panel, and selected or open notes get a ring as well as a colour change.
- **Colour-blind palette** (Okabe-Ito), **high contrast** (also switched on by the system "more contrast" setting), and adjustable label size.
- **Without WebGL** the 3D view is replaced by the list, search and details panel.

## Settings

Flow (off, calm, lively), camera rotation and speed, glow and bloom, palette, label size and count, grouping (folder, first tag, none), folder depth, excluded folders, whether to show notes with no links, and whether to ring the open note.

## Privacy and safety

No network access, no telemetry, no remote code. Everything, including Three.js, is bundled into `main.js`. Note titles are only ever written as text, never as HTML. The plugin reads your notes' names and links (from Obsidian's own index) and, when grouping by tag, their first tag. It does not read note contents or write to your vault.

## Performance

Rendering uses point sprites and line segments rather than a mesh per note. A tick of the layout engine costs more as the vault grows, so above a few thousand notes it uses cheaper repulsion and runs at a lower rate when frames get slow, and the bloom pass is dropped first on slow machines. When nothing is moving (motion off or paused, and the camera at rest) it draws nothing.

## Known limitations

- Desktop only (it needs WebGL and a pointer).
- Pop-out windows are not specifically supported yet.
- Very large vaults (roughly 10,000+ notes) will be slow to lay out; exclude folders to thin the graph.

## Development

```bash
npm install
npm run dev          # esbuild watch, writes main.js
npm run build        # type-check, then minified production main.js
npm run harness -- "<path to a vault>"   # builds dev/harness.html, a browser preview using that vault's notes as mock data
npm run install-local -- "<path to a vault>"   # build and copy into <vault>/.obsidian/plugins/constellation-graph
```

Source layout: `src/main.ts` (plugin), `view.ts` (Obsidian view), `data.ts` (vault to graph), `app.ts` (UI, keyboard, accessibility), `renderer.ts` (Three.js), `sim.ts` (layout and flow), `fallback.ts` (no-WebGL mode), `settings.ts`, `palette.ts`.

## Licence and third-party notices

MIT, see `LICENSE`. The bundled `main.js` includes:

- [Three.js](https://threejs.org), MIT licence, copyright the Three.js authors.
- [d3-force-3d](https://github.com/vasturiano/d3-force-3d), MIT licence, copyright Vasco Asturiano; it builds on [d3-force](https://github.com/d3/d3-force) (ISC licence, copyright Mike Bostock) and related d3 modules (ISC, BSD-3-Clause).

Full licence text for each travels with its package under `node_modules` and is preserved at the end of `main.js`.
