# Constellation Graph

A fluid, slowly orbiting 3D map of your notes for [Obsidian](https://obsidian.md), with a **Pilot mode** that lets you fly a small starfighter through it. Notes glow as points of light, coloured by folder (or tag). Clusters swirl around their own centres and drift past one another, like a screensaver for your vault, while the camera slowly circles. Everything is built to stay usable: full keyboard control, screen-reader announcements, a searchable note list, a colour-blind-safe palette, a high-contrast mode, and no motion at all if your system asks for reduced motion.

> Early release. Listing and install details: [Constellation Graph on the Obsidian community site](https://community.obsidian.md/plugins/constellation-graph).

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
| Right-click | Clear selection and target lock, cancel pending double-click/double-shot actions, and close the details panel |

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

### Pilot mode

Press **P** in the graph (or the plane button on the toolbar) and fly a small four-winged fighter through your notes. Shoot a note to select it, shoot it again to open it. The plane has weight: it takes a moment to start and stop a turn, it coasts when you let go of the throttle, sharp turns cost a little speed, and a trailing camera follows it. Notes are solid, so you bounce off them. Pilot mode never edits a note; shooting and opening do what a click already does.

| Key | Action |
|---|---|
| W / S | Thrust / reverse |
| A / D | Strafe |
| Space / C | Up / down |
| Q / E | Roll |
| Shift | Afterburner (uses an energy tank; when it runs dry it stays empty for a few seconds before it refills) |
| X | Brake |
| Mouse | Steer (see **Mouse mode** below) |
| Click or F | Fire a blaster bolt at what is under the crosshair |
| T | Lock or unlock the target |
| G | Warp to the target (travel to the marked shared star in multiplayer) |
| H | Warp back out to see the whole graph (disabled in multiplayer) |
| V | Switch between chase and cockpit view |
| K | Show or hide the controls panel |
| Esc | Free the mouse (a second Esc leaves) |
| P | Leave Pilot mode |

The controls are also shown on screen as a small panel of key caps that light up as you press them, and fades after a few seconds.

- **Mouse mode.** *Capture* hides the pointer and steers with its movement. *Cursor* keeps the pointer visible and steers by how far it is from the centre, with a dead zone and two faint rings to show it; over a panel or button it stops steering, so you can click the legend, toolbar and details panel while flying.
- **Scale.** Cruise speed is set from the size of your vault, so a bigger vault takes longer to cross: about 12 seconds across a 100-note vault at cruise speed, longer for larger ones. The *Flight speed* setting scales it. Warps take time in proportion to the distance.
- **Wireframes and sound.** The plane has a glowing wireframe outline, and target brackets, impact bursts and faint shells around each group are drawn in wireframe too (they can be turned off). Engine, afterburner, blaster and warp sounds are synthesised in the plugin with the Web Audio API; no audio files are loaded. The Pilot HUD has separate saved **Mute engine** and **Mute afterburner** controls. They do not mute blasters, and the master sound and volume controls still apply. Sound mutes when the window loses focus.
- Pilot mode needs motion, so it stays off when your system asks for reduced motion (the search, note list and details panel still work). It is not available without WebGL.

### Multiplayer rooms

The panel shows the version of the loaded plugin code, the selected connection mode, and the room-service hostname. Include those lines and the full status message when reporting a connection failure. A WebSocket close code is included when the server closes before room setup finishes.

Player rows say **Waiting for flight state** until their first authoritative update, then show **flying** or **spectator**. A timeout from one STUN or TURN endpoint is informational while other connection paths are still being tried; an actual peer-connection failure is shown separately.

Open the **Multiplayer** panel, enter a display name, and check the shared-data notice. Create a room to get an eight-character code, then share it with up to three other pilots; or enter a code to join someone else's room. The panel includes **Copy code** and **Leave** controls, participant names, health and state, and connection status. Hosted rooms are the default, so players do not set up a server. Each pilot has a nearby region in the shared flight space, and all constellation regions use the same flight scale.

Joining shares anonymous star positions, connections, and group colors. It never sends note titles, paths, tags, or contents. Remote constellations have circular stars and no labels, note details, search, selection, dragging, or opening actions. In a room, all note selection and opening is disabled, including for your own notes. Click a star in the shared map, or aim at one and press **T**, to mark it for navigation. Enter Pilot mode and press **G** to fast travel there; destinations may be any participant's anonymous stars. Press **T** again while aiming to change the target. Right-click clears it. **H** remains disabled in a room. Maps update as notes and links change. Each map spreads to twice its solo size around its region center, and ships appear twice as large. A subtle red marker points toward each other flying player and shows their name and distance. Sharing supports up to 20,000 stars and 100,000 links per vault; larger maps show an error instead of silently omitting notes.

Rooms use WebRTC data channels for maps and flight. The hosted room service passes room codes and peer setup messages, and automatically supplies temporary TURN relay credentials when direct connections fail. Its Metered relay allowance is shared by all players; the current deployment uses a 500 MB monthly free trial with a hard stop and no automatic reload. Direct connections may still work after the relay allowance is used, while players who require TURN may be unable to connect until it resets. To use another deployment, choose **Custom server** in the plugin's Multiplayer settings. See [server/README.md](server/README.md) for the hosted-service limits and self-hosted deployment guides.

Firing at other pilots is optional: fly together peacefully or choose to engage. Blasters fire from the visible cannons and their hits are resolved by the room host. A blaster hit removes 10 of 100 health. Destruction is followed by a five-second respawn with full health and boost, then three seconds of spawn protection; firing ends protection. Boost drains at 28% per second, recharges at 8% per second after 1.5 seconds without boosting, and stays empty for three seconds when depleted. Leaving Pilot mode or hiding the game view makes you a spectator; returning takes five seconds and preserves your health and boost. All players in a room must use compatible plugin version 0.3.2 or newer.

The hosted service keeps room membership, short-lived relay configuration, and the latest small combat checkpoint in memory, and does not log gameplay payloads or credentials. The relay provider carries only WebRTC-encrypted peer traffic and can observe connection metadata. Room membership disappears when the last player leaves. Outside an active room, the plugin does not connect to the network.

### Accessibility

- **Reduced motion.** If your operating system requests reduced motion, flow, orbiting and camera flights are turned off: the layout settles once and stays still, dragged notes return at once instead of bouncing, and Supernova just recomputes the layout instantly without the show. Animate still works because you asked for it, but without the pop-in effects. You can also set motion to *Off* yourself, or pause at any time.
- **No strobing.** The Supernova has a single soft flash that fades over about a second, and it is skipped under reduced motion and in high-contrast mode.
- **Screen readers.** The canvas is hidden from assistive technology and replaced by a status region that announces the selected note, its group and link count. The note list, search, group legend and details panel are ordinary buttons and lists.
- **No colour-only meaning.** Group names are always shown in the legend, tooltip and details panel, and selected or open notes get a ring as well as a colour change.
- **Colour-blind palette** (Okabe-Ito), **high contrast** (also switched on by the system "more contrast" setting), and adjustable label size.
- **Without WebGL** the 3D view is replaced by the list, search and details panel.

## Settings

Open on startup (off by default; saved in the vault, so it applies to anyone who opens it), flow (off, calm, lively), camera rotation and speed, glow and bloom, palette, label size and count, grouping (folder, first tag, none), folder depth, excluded folders, whether to show notes with no links, and whether to ring the open note. Pilot mode has its own section: enable, mouse mode (capture or cursor), mouse sensitivity, invert vertical look, flight speed, agility, view (chase or cockpit), wireframe effects, sound and volume, and separate saved engine and afterburner mutes. Multiplayer settings include the display name and Hosted or Custom server selection; the saved `ws://localhost:8787` development address migrates to Hosted.

## Privacy and safety

Outside an active room, the plugin does not make network connections. When you explicitly join, WebRTC peers receive a lossy anonymous map of star coordinates, connections, and colors. The plugin does not send note names, paths, tags, or contents, and network messages cannot call Obsidian note-opening actions. The room service sees room codes, display names, peer setup messages, and compact host checkpoints; it keeps membership and checkpoints in memory and does not log payloads or credentials. Gameplay normally travels peer-to-peer. If TURN is needed, the relay provider can see IP addresses and traffic volume, while WebRTC encrypts the payloads. Everything, including Three.js, is bundled into `main.js`. Note titles are only ever written as text, never as HTML. Pilot sound is generated by the plugin; no audio files are loaded or sent. The plugin reads note names and links from Obsidian's index and, when grouping by tag, the first tag. It does not read note contents or write to your vault.

## Performance

Rendering uses point sprites and line segments rather than a mesh per note. A tick of the layout engine costs more as the vault grows, so above a few thousand notes it uses cheaper repulsion and runs at a lower rate when frames get slow, and the bloom pass is dropped first on slow machines. When nothing is moving (motion off or paused, and the camera at rest) it draws nothing.

## Known limitations

- Desktop only (it needs WebGL and a pointer), and Obsidian 1.7.2 or newer.
- Pop-out windows are not specifically supported yet.
- Very large vaults (roughly 10,000+ notes) will be slow to lay out; exclude folders to thin the graph.

## Development

```bash
npm install
npm ci --prefix server # signaling service dependency
npm run dev          # esbuild watch, writes main.js
npm run build        # type-check, then minified production main.js
npm test             # synthetic privacy, protocol, combat, and signaling tests
npm run build:hosted --prefix server  # validate the Cloudflare Worker bundle
npm run harness -- "<path to a vault>"   # builds dev/harness.html, a browser preview using that vault's notes as mock data
npm run install-local -- "<path to a vault>"   # build and copy into <vault>/.obsidian/plugins/constellation-graph
```

Source layout: `src/main.ts` (plugin), `view.ts` (Obsidian view), `data.ts` (vault to graph), `app.ts` (UI, keyboard, accessibility), `renderer.ts` (Three.js), `sim.ts` (layout and flow), `pilot.ts` (Pilot mode: flight, aiming, collisions, HUD), `multiplayer.ts` (anonymous map protocol and WebRTC mesh), `combat.ts` (host-authoritative flight and combat), `server/worker.js` (hosted Durable Object service), `server/index.js` (self-hosted Node signaling), `server/` (deployment files), `ship.ts` and `cockpit.ts` (the plane and its cockpit, built from primitives), `sfx.ts` (synthesised sound), `fallback.ts` (no-WebGL mode), `settings.ts`, `palette.ts`.

## Licence and third-party notices

MIT, see `LICENSE`. The bundled `main.js` includes:

- [Three.js](https://threejs.org), MIT licence, copyright the Three.js authors.
- [d3-force-3d](https://github.com/vasturiano/d3-force-3d), MIT licence, copyright Vasco Asturiano; it builds on [d3-force](https://github.com/d3/d3-force) (ISC licence, copyright Mike Bostock) and related d3 modules (ISC, BSD-3-Clause).
- [ws](https://github.com/websockets/ws), MIT licence, used by the separate signaling service.

Full licence text for each travels with its package under `node_modules` and is preserved at the end of `main.js`.
