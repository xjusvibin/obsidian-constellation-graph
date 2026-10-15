# Starfield Graph

*Formerly Constellation Graph: the same plugin, with the same id, so your settings and updates carry over.*

**Your vault as a living night sky, with a starfighter you can fly through it.** A fluid, slowly orbiting 3D map of your notes for [Obsidian](https://obsidian.md), with a flying sandbox you can share with up to three friends.

![Your notes as glowing points of light, coloured by folder](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/overview.png)

> **A screensaver for your vault.** Notes glow as points of light, coloured by folder or tag. Clusters swirl around their own centres and drift past one another while the camera slowly circles. It updates live as you add, rename and link notes.

> **It never touches your notes.** The plugin reads note names and links only. It does not read note contents or write to your vault, and Pilot mode never selects, opens or changes a note.

> **Built to stay usable.** Full keyboard control, screen-reader announcements, a searchable note list, a colour-blind-safe palette, a high-contrast mode, and no motion at all if your system asks for reduced motion.

## Highlights

| | |
|---|---|
| **Orbit, search and explore** | Drag to orbit, scroll to zoom, click a note to fly to it, double-click to open it. A searchable list and group legend sit alongside. |
| **Animate and Black hole** | A timelapse that rebuilds your vault in the order you wrote it, and a black hole that pulls your whole graph into an accretion disk before it lets go and the layout re-forms. |
| **Pilot mode** | Fly a starfighter through your notes in a sandbox with real weight and momentum, an afterburner, a blaster and a cannon, and three ships to choose from. |
| **Folded groups** | Fold every folder or tag into one glowing point, then shoot it open and watch its notes fly back out. |
| **Fly together** | Up to four pilots share one sky, each with their own constellation, through a code-sealed room. No server to run, and never a note title shared. |
| **Private by design** | No network connections outside a room, no telemetry, no remote code. Everything is bundled into `main.js`. |

## Gallery

| | |
|---|---|
| ![Folders folded into single glowing points](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/folded-groups.png) | ![Flying the Dart in chase view, with the flight controls panel](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/pilot-chase.png) |
| **Folded groups.** Every folder as one point, with its name and size. | **Pilot mode.** The Dart in chase view, with wireframe shells around each group and an on-screen controls panel. |
| ![The Dart cockpit](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/cockpit-dart.png) | ![The Bulwark cockpit](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/cockpit-bulwark.png) |
| **Cockpit view: Dart.** A slim bubble canopy and two guns on each wing. | **Cockpit view: Bulwark.** An armoured frame with four cannons in the nose. |
| ![The Bulwark gunship in chase view](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/ships-bulwark.png) | ![The Fly together panel with three pilots](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/fly-together.png) |
| **Three ships.** Striker, Dart and Bulwark: different looks and cockpits, the same flight and fight. | **Fly together.** Make a room, share the code, pick your ship. (Demo names.) |

![Kill announcements and the scoreboard](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/scoreboard.png)

*Kill announcements at the top and the scoreboard (hold Tab) in a room. Demo names.*

## Install

Search for **Starfield Graph** in Settings, Community plugins, Browse. Or copy `main.js`, `manifest.json` and `styles.css` from a [release](https://github.com/xjusvibin/obsidian-constellation-graph/releases) into `<vault>/.obsidian/plugins/constellation-graph/` and enable it. Desktop only, Obsidian 1.7.2 or newer.

Open it from the ribbon icon (orbit) or the command **Open starfield graph**.

## Using the graph

Your selection and any hidden groups are kept as the vault changes.

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
| **Black hole** | A horizon forms at the middle of the graph and gravity pulls every note in: they swirl inward on spirals, shrink and redden as they are stretched toward it, and are swallowed when they cross the horizon, which grows as it feeds. You see the accretion disk (brighter on the side moving toward you), the ring of light bent over the hole, orbiting gas, and the stars and notes behind it bent into an Einstein ring (this last needs the glow pass, so not on the Low quality setting). When it has fed it lets go in one soft flash, the layout re-forms from scratch, and a wave of light runs outward along the shortest paths from the most-connected note. Press again to stop |
| **Pilot** (plane) | Fly through your notes in a sandbox (see below) |
| **Fold** (circled plus) | Fold every group into one point, or open them all |
| **Fly together** (people) | Make or join a multiplayer room (see below) |
| **Save image** (camera) | Saves the current view as a PNG download (also the **I** key). It is a download, never a file in your vault, and it contains only the 3D scene, so no note names are in it |
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
| G | Fold every group into one point, or open them all |
| N | Black hole |
| O | Tour: the camera visits a chain of linked notes, a few seconds at each (also a command: "Tour the linked notes") |
| I | Save an image of the view |
| R | Reset the view |
| L | Show or hide the note list |
| / | Focus search |
| Esc | Clear selection, close a panel |

## Pilot mode (a flying sandbox)

Press **P** in the graph (or the plane button on the toolbar) and fly a small starfighter through your notes. Pilot mode is a **sandbox**: it never selects, opens or changes a note, and the rest of the plugin works exactly as before outside it. The plane has weight: it takes a moment to start and stop a turn, it coasts when you let go of the throttle, a trailing camera follows it, and the afterburner draws on an energy tank (it does not refill for two seconds after you are hit). Notes are solid, so you bounce off them. Blaster bolts make a splash where they land and can open a folded group (below), nothing more.

| Key | Action |
|---|---|
| W / S | Thrust / reverse |
| A / D | Strafe |
| Space / C | Up / down |
| Q / E | Roll |
| Shift | Afterburner (uses an energy tank; when it runs dry it stays empty for three seconds before it refills) |
| X | Brake |
| Mouse | Steer (see **Mouse mode** below) |
| Click or F | Fire a blaster |
| T | Lock a pilot (in a room): missiles home on them (T again lets go) |
| G | Warp to the target |
| H | Warp back out to see the whole graph |
| B | Fold the group of the note you are aiming at into one point (Shift+B folds every group, or opens them all) |
| V | Switch between chase and cockpit view |
| R | Switch blaster / cannon |
| N | Watch other pilots (in a room) |
| M or right-click | Fire a missile (you need one: fly into a red pickup) |
| Tab | Scoreboard (hold, in a room) |
| K | Show or hide the controls panel |
| Esc | Free the mouse (a second Esc leaves) |
| P | Leave Pilot mode |

![The Dart in chase view](https://raw.githubusercontent.com/xjusvibin/obsidian-constellation-graph/main/images/pilot-chase.png)

The controls are also shown on screen as a small panel of key caps that light up as you press them, and fades after a few seconds.

- **Mouse mode.** *Capture* hides the pointer and aims directly: the nose turns exactly as far as the mouse moves and stops when it stops, so lining up a shot is easy. *Cursor* keeps the pointer visible and steers by how far it is from the centre, with a dead zone and two faint rings to show it; over a panel or button it stops steering, so you can still click the toolbar while flying.
- **Scale.** Cruise speed is set from the size of your vault, so a bigger vault takes longer to cross: about 12 seconds across a 100-note vault at cruise speed, longer for larger ones. The *Flight speed* setting scales it. Warps take time in proportion to the distance.
- **Folded groups.** Each group (a folder, or a tag) can be folded into one glowing point with its name and size. Shoot a folded group, or click it in the normal view, to open it and watch its notes fly back out. A vault of more than 400 notes starts folded the first time you fly (a setting). In the normal view, the toolbar button or **G** folds every group, or opens them all.
- **Powerups and missiles.** Six pickups float in the sky: red ones give a missile (you can carry two), blue ones refill your shield, green ones refill the afterburner. Fly into one to take it; it comes back after 30 seconds. Press **T** to lock the pilot in front of your crosshair (T again lets go): the lead pip follows them and your missiles **home** on them, turning only so fast, so a good pilot can still dodge. A missile is slow but heavy (60 damage at the middle of a ship, half at the edge of its blast). If it hits one of your **folded groups**, the group breaks: its notes scatter around the sky as **meteors** for 20 seconds, and each meteor that hits a ship does 15 damage. Meteors are only pictures of the group and never touch a note (the real group simply opens, as when you shoot it). In a room everyone sees the same pickups, missiles and meteors, and each pilot's own computer decides whether *they* were hit; on your own it is a show with no damage.
- **Weapons.** The blaster is quick and runs hot: hold the trigger and it overheats, then goes cold for a moment. The cannon hits three times as hard but each life carries a limited number of rounds (they return when you respawn). Each gun has a best range (blaster 70 to 420, cannon 160 to 650): a hit inside it does a quarter more damage, and past it the damage fades to about half. The lead pip turns green when you are in range, and a hit flashes your crosshair.
- **Ships.** Choose a Striker (four wings), Dart (delta wing) or Bulwark (heavy gunship) in the settings. They look different and fly and fight the same; other pilots see your choice.
- **In a room.** Other ships carry a nameplate (name, health, distance) and an edge arrow when off-screen. A lead pip shows where to aim at a moving pilot, and an arc on the screen points toward whoever just hit you (blue for the shield, red for the hull). Every ship is the same size wherever it is, with a ring that stays visible when a pilot is far away. When someone is destroyed an announcement appears at the top of the view, and holding **Tab** shows the scoreboard (kills and deaths, also listed in the Fly together panel). The note list and group list are put away while you are in a room, so your note and folder names are never on screen in a lobby. **N** watches the other pilots; after 30 seconds without a key in a room you start watching automatically, and any flight key brings you back.
- **Names while you fly.** Only the note you are aiming at or have locked, the notes close to your ship (fading in as you approach), and the vault's most-connected note are named, so the view is never covered in labels.
- **Speed you can see.** The view widens under afterburner, and dust streaks past as you go faster.
- **Wireframes and sound.** The plane has a glowing wireframe outline, and target brackets, impact bursts and faint shells around each group are drawn in wireframe too (they can be turned off). Engine, blaster, impact and warp sounds are synthesised in the plugin with the Web Audio API, nothing is loaded from a file, and they can be turned off or turned down. Sound mutes when the window loses focus.
- Pilot mode needs motion, so it stays off when your system asks for reduced motion (the search, note list and details panel still work). It is not available without WebGL.

- **Controller.** A game controller works with the standard layout, with no setup, laid out like Rocket League: left stick moves and strafes, right stick looks, right trigger fires, left trigger launches a missile, B is the afterburner, A goes up (a click of the left stick goes down), X brakes, Y changes the view, the bumpers roll (left bumper left, right bumper right), the d-pad locks a pilot (up), switches weapon (left) and returns to the hub (down), and Back holds the scoreboard.
- **Practice drones.** Flying alone, red target drones circle your graph in waves: each wave is a little bigger, tougher and faster. Shoot them all and the next wave comes. **T** locks a drone and your missiles home on it. They are never there in a room, and a setting turns them off.
- **Arcade run.** Press **Enter** while flying alone for a timed three-minute run against the waves. The score is 1,000 per wave cleared and 100 per drone shot. At the end an arcade-style screen asks for your name if it is a high score, shows the top ten, and lets you play again, submit the score or look at the public board (both optional; see the privacy section).
- **First-flight tips.** The first time you fly alone, a short checklist (fly, steer, fire, afterburner, shoot a drone) appears and finishes itself. It never comes back unless you turn it on again in the settings.
- **Volume and keys.** The **-** and **=** keys turn the volume down and up while you fly. The command **Edit pilot keys** (command palette) lets you rebind every flight action; a few keys (Escape, P, Tab) are kept for leaving flight and the scoreboard.
- **Controller settings.** Look speed, dead zone and an aim-assist option (the right stick slows a little when the crosshair is near a note or a drone) are in the settings.
- **Ship colours.** Choose a colour in the Fly together panel (or in the settings); other pilots see it. **Remember the camera** (a setting, off by default) opens the graph from the angle you left it.

## Fly together (multiplayer)

Up to four pilots can share one sky, each with their own constellation. Click the people button on the toolbar, choose **Make a room**, and send the ten-character room code to your friends; they paste it under **Join**. Or press **Copy invite link** and send that: opening it starts Obsidian with the code already filled in (the link holds only the code, and nothing is joined until your friend presses **Join**). Then everyone presses **P** to fly.

- **What is shared:** the *shape* of your constellation (anonymous points, links and group colours) and where your ship is. **Never** note titles, paths, tags or contents: remote constellations have no labels, and nothing a remote pilot sends can reach a note, a file or Obsidian itself.
- **How it connects:** there is no server to run. Pilots find each other through a public relay (the free [ntfy.sh](https://ntfy.sh) service by default, or one you choose in the settings). Every message through the relay is sealed with a key made from the room code, so the relay sees only noise, and nobody without the code can listen or take part. The relay carries only a handful of connection-setup messages; after that, pilots talk to each other directly (WebRTC), and your computer's address is visible to the other pilots and to the STUN servers that help the connection through your router.
- **The rules in a room:** every pilot flies their own ship with the full flight model, at the same cruise speed. Each constellation sits still in its own corner of the sky, and there is no warping. Ships can shoot each other: every ship has a 40-point shield and a 100-point hull: hits take the shield first, the shield comes back by itself after 3.5 seconds without a hit, and the hull does not heal (a blaster hit is 10 and a cannon round 30, before the range bonus). Destroying another pilot patches the hull by 30 and recharges your shield, and a destroyed ship comes back after five seconds with three seconds when nothing can hit it, and each pilot's own computer decides whether *they* were hit. There is no score. Ships pass through one another.
- **If it will not connect:** some networks block direct connections. You can enter your own TURN server in the settings and it will be used when a direct connection fails; nothing is set up for you. The free relay has usage limits, so a very busy day may need a different relay.
- **Rounds.** The host can start a round from the panel: first to 5 or 10 kills, or the most kills in 3 or 5 minutes. Everyone's score starts again from nothing, the status shows at the top, and a banner names the winner. Only the host's start is accepted. You also come back to life away from the other pilots, at one of four spots around your constellation.
- **Reliability.** Every room carries a protocol version, so a pilot on a version the room no longer supports is told to update instead of joining half-working. A pilot who joins mid-round is told the round, the time left and the scores. A brief network blip is mended in place (the connection search is restarted) before a pilot is dropped. **Copy diagnostics** puts versions, the relay name, ping, loss and how each pilot is reached (same network, through a router, or through a TURN relay) on the clipboard for a bug report; it holds no room code, names, addresses or note data. The host is the pilot who has been in the room longest; if they leave, the next one takes over.
- The Fly together panel shows each pilot's round-trip time (green under 80 ms, amber under 160, red above, and also how many recent pings were lost once it is 10 percent or more), measured with a tiny ping every two seconds over the direct link. **Lobby browser.** **Browse rooms** lists rooms whose hosts have turned on *List this room publicly*; press Join on one and the code is filled in (you still press Join in the panel). The host can remove a pilot with **Remove**. There is no server: listed rooms announce themselves (a name, the code and a pilot count, nothing about the vault) to one fixed public topic on the relay every 15 seconds, and the browser reads that topic. A listed room is public, so anyone can join it and will see the host's network address as in any room; names and codes come from strangers, so each announcement is checked, cleaned, rate limited and capped, and a removed pilot can come back (this is not a ban). A room closes when the last pilot leaves. Your vault is never changed, and changes you make to it while in a room appear when you leave.

## Accessibility

- **Reduced motion.** If your operating system requests reduced motion, flow, orbiting and camera flights are turned off: the layout settles once and stays still, dragged notes return at once instead of bouncing, and the black hole just recomputes the layout instantly without the show. Animate still works because you asked for it, but without the pop-in effects. You can also set motion to *Off* yourself, or pause at any time.
- **No strobing.** The black hole has a single soft flash that fades over about a second, and it is skipped under reduced motion and in high-contrast mode.
- **Screen readers.** The canvas is hidden from assistive technology and replaced by a status region that announces the selected note, its group and link count. The note list, search, group legend and details panel are ordinary buttons and lists.
- **No colour-only meaning.** Group names are always shown in the legend, tooltip and details panel, and selected or open notes get a ring as well as a colour change.
- **Colour-blind palette** (Okabe-Ito), **high contrast** (also switched on by the system "more contrast" setting), and adjustable label size.
- **Without WebGL** the 3D view is replaced by the list, search and details panel.

## Settings

Open on startup (off by default; saved in the vault, so it applies to anyone who opens it), flow (off, calm, lively), camera rotation and speed, quality (automatic, low, balanced or high), glow and bloom, node size, link brightness, spacing (how far apart notes and groups sit), palette, label size and count, grouping (folder, first tag, none), folder depth, excluded folders, whether to show notes with no links, and whether to ring the open note. Pilot mode has its own section: enable, fold groups when flying, ship, mouse mode (capture or cursor), mouse sensitivity, invert vertical look, flight speed, agility, view (chase or cockpit), wireframe effects, sound and volume. Multiplayer has its own too: your name, the relay, and an optional TURN server. *Tell me about new versions* is off by default.

## Privacy and safety

**Outside a multiplayer room the plugin makes no network connections** (with two optional exceptions you choose yourself, below), has no telemetry and loads no remote code. Everything, including Three.js, is bundled into `main.js`. Note titles are only ever written as text, never as HTML. Pilot mode's sound is generated by the plugin itself; no audio files are loaded or sent anywhere. The plugin reads your notes' names and links (from Obsidian's own index) and, when grouping by tag, their first tag. It does not read note contents or write to your vault, and Pilot mode never selects or opens a note.

**Optional arcade scores (only when you press the button).** After a timed arcade run (Enter, flying alone) the high-score table is kept on your computer, in this vault's plugin settings. Two buttons use the network, and only when you press them: *Submit score* sends your arcade name and score (nothing else, no note or vault data, and no network address of yours beyond what any web request reveals) to a public topic on the relay (ntfy.sh by default), and *Public board* reads that topic. Anyone can read or post there, so scores on the public board are not verified, and the relay forgets them after about twelve hours. Names are limited to twelve capital letters, digits and a few symbols.

**Optional update notice (off by default).** If you turn on *Tell me about new versions*, or run the command *Check for a new version*, the plugin sends one request to GitHub's public releases API (`api.github.com`) to read the latest version number, at most once a day, and shows a notice with a link if there is a newer one. Nothing is downloaded or installed, and nothing about you or your vault is sent. Obsidian's own Community plugins page remains the way to update.

**When you make or join a multiplayer room**, and only then (besides the optional notice above), the plugin uses the network like this:

- a few small, sealed messages go through the relay you chose (ntfy.sh by default) to set up connections. They are encrypted with a key made from the room code, so the relay cannot read or change them, but it can see that *something* was sent, when, and from which address;
- public STUN servers (Google's and Cloudflare's) help your connection through your router, and see your address;
- if you **browse rooms** or **list your room**, the plugin reads (or posts to) one fixed public topic on the same relay, and the announcements there are plain text (a name, a room code and a pilot count);
- the other pilots in the room receive an anonymous map of your constellation (points, links, colours, no names of any kind) and your ship's position, and can see your address, as with any direct connection;
- if you have entered your own TURN server in the settings, it is used when a direct connection fails.

Display names are cleaned before anyone sees them. Everything a remote pilot can send is checked and size-limited before it is used.

## Performance

Rendering uses point sprites and line segments rather than a mesh per note. A tick of the layout engine costs more as the vault grows, so above a few thousand notes it uses cheaper repulsion and runs at a lower rate when frames get slow, and the bloom pass is dropped first on slow machines. When nothing is moving (motion off or paused, and the camera at rest) it draws nothing.

## Known limitations

- Desktop only (it needs WebGL and a pointer), and Obsidian 1.7.2 or newer.
- Pop-out windows are not specifically supported yet.
- Very large vaults (roughly 10,000+ notes) will be slow to lay out; exclude folders to thin the graph. A room shares up to 20,000 notes and 100,000 links per vault.
- Multiplayer needs a network that allows direct connections, unless you set up your own TURN server. It has been tested with two pilots on one computer, and with the unit tests, but not yet across the internet between real Obsidian installs.

## Development

`npm run screenshots -- <demo-vault> [out-dir]` builds the dev harness and takes the overview, folded, pilot and cockpit screenshots with headless Edge or Chrome.

`npm run relay` starts a tiny stand-in for the relay on `http://127.0.0.1:8788` (set it as the relay address in two browser tabs of the dev harness to test a room on one computer). The room handshake, the protocol version check and the sealed messages are covered by `npm test` against an in-memory relay.

```bash
npm install
npm run dev          # esbuild watch, writes main.js
npm run build        # type-check, then minified production main.js
npm test             # unit tests for the room, encryption and what is shared
npm run balance      # prints time-to-kill for every gun and range from the real constants
npm run harness -- "<path to a vault>"   # builds dev/harness.html, a browser preview using that vault's notes as mock data
npm run install-local -- "<path to a vault>"   # build and copy into <vault>/.obsidian/plugins/constellation-graph
```

Source layout: `src/main.ts` (plugin), `view.ts` (Obsidian view), `data.ts` (vault to graph), `app.ts` (UI, keyboard, accessibility), `renderer.ts` (Three.js), `sim.ts` (layout and flow), `pilot.ts` (Pilot mode: flight, aiming, collisions, HUD), `ship.ts` and `cockpit.ts` (the plane and its cockpit, built from primitives), `speedfx.ts` (speed dust), `weapons.ts` (blaster, cannon, lead pip), `sfx.ts` (synthesised sound), `multiplayer.ts` (the room session: anonymous topology, position frames, checks), `room.ts`, `relay.ts` and `netcrypto.ts` (finding other pilots through a relay, sealed with the room code), `remote.ts` (other pilots' constellations, ships and bolts), `multiplayerUi.ts` (the Fly together panel), `fallback.ts` (no-WebGL mode), `settings.ts`, `palette.ts`.

## Credits

The multiplayer anonymous-topology format, binary position frames, chunked transfers and the checks on everything a remote pilot can send are adapted from the multiplayer work by [j117mw3](https://github.com/j117mw3) in [pull request #1](https://github.com/xjusvibin/obsidian-constellation-graph/pull/1), with thanks. The connection set-up (a code-sealed public relay instead of a hosted server) and the flight and combat rules are different.

## Licence and third-party notices

MIT, see `LICENSE`. The bundled `main.js` includes:

- [Three.js](https://threejs.org), MIT licence, copyright the Three.js authors.
- [d3-force-3d](https://github.com/vasturiano/d3-force-3d), MIT licence, copyright Vasco Asturiano; it builds on [d3-force](https://github.com/d3/d3-force) (ISC licence, copyright Mike Bostock) and related d3 modules (ISC, BSD-3-Clause).

Full licence text for each travels with its package under `node_modules` and is preserved at the end of `main.js`.
