**0.7.2: the controller, laid out like Rocket League.** The bumpers roll (left bumper left, right bumper right), B is the afterburner, A goes up (click the left stick to go down), X brakes, Y changes the view, and the d-pad locks a pilot (up), switches weapon (left) and returns to the hub (down). Triggers still fire and launch missiles. Fixed: the d-pad no longer rolls the wrong way.

**0.7.1: a better controller layout.** Right trigger fires, left trigger launches a missile, right bumper (or a click of the left stick) is the afterburner, left bumper brakes, A and B go up and down, X switches weapon, Y locks a pilot, the d-pad rolls (up changes the view, down returns to the hub), and Back holds the scoreboard. A small readout at the bottom left of Pilot mode names your controller and lights up while you use it, so you can see the plugin has found it.

**0.7.0: rounds, tours, controller support and ship colours.**

- **Rounds:** the host can start a round from the Fly together panel: first to 5 or 10 kills, or the most kills in 3 or 5 minutes. Scores start again, a status bar shows at the top and a banner names the winner. Only the host's start is accepted.
- **Respawn away from the fight:** you come back at the one of four spots around your constellation that is farthest from the other pilots.
- **Ship colours:** pick one of nine; other pilots see it.
- **Tours:** press O (or run "Tour the linked notes") and the camera visits a chain of linked notes, a few seconds at each. Touching the camera ends it.
- **Controller support:** a game controller works with the standard layout and no setup (sticks move and look, triggers fire and brake, bumpers for afterburner and missile).
- **Remember the camera:** an optional setting (off by default) that opens the graph from the angle you left it.

**Starfield Graph** (formerly Constellation Graph). Same plugin and same id, so your settings and updates carry over; the new name says what it has become.

Pilot mode becomes a sandbox, and you can now fly together.

**Fly together (multiplayer).** Make a room, send the ten-character code to up to three friends, and share one sky, each pilot with their own constellation. Only the shape of a constellation (anonymous points, links, colours) and your ship's position are shared; never note titles, paths, tags or contents. Connections are set up through a public relay (ntfy.sh by default, or your own), with every message sealed by the room code, then pilots talk directly. There is no server to run and nothing is set up for you; you can add your own TURN server if your network blocks direct connections. Outside a room the plugin still makes no network connections. Thanks to j117mw3 for the multiplayer protocol work this builds on.

**Lock-on:** the T key now locks the pilot in front of your crosshair (it used to lock a note, which did nothing useful). Your missiles home on a locked pilot, turning only so fast so a boosting pilot can still dodge, and the lead pip follows them.

**Lobby browser:** a Browse rooms button lists rooms whose hosts have chosen to list them publicly (off by default, with a clear warning), and hosts can remove a pilot. It uses one public topic on the relay, so there is still no server, and every announcement from a stranger is checked, cleaned, rate limited and capped.

**Invite links:** the Fly together panel has a Copy invite link button. Opening the link starts Obsidian with the room code filled in; your friend still presses Join.

**Black hole:** the Supernova is now a physical black hole. Gravity pulls every note in on a spiral, a horizon grows as it feeds, and you see an accretion disk, a lensed ring of light, orbiting gas and the background bending around it; then it lets go and the layout re-forms.

**Pilot mode is a sandbox.** It never selects or opens notes, and the rest of the plugin works as before outside it. Animate and Supernova are off while you fly or are in a room.

- **Two weapons:** a blaster that runs hot and overheats, and a cannon that hits three times as hard but carries limited rounds per life (R switches).
- **Three ships to choose from:** Striker, Dart and Bulwark, each with its own look and its own cockpit view. Pick yours in the settings or in the Fly together panel.
- **Hits you can trust:** bolts now fly the same on everyone's screen (they keep your ship's speed and are not a moment behind), the target grows a little the further a bolt flew, and every gun has a best range: inside it a hit does a quarter more damage, past it the damage fades. The lead pip turns green when you are in range, and a hit flashes your crosshair.
- **One size for every ship:** your ship and everyone else's are the same size wherever they are, with a ring that stays visible on screen when a pilot is far away.
- **Direct mouse aim:** the nose now turns exactly as far as the mouse moves and stops when it stops, with a tighter chase camera, so lining up a shot is easy. Cursor steering is crisper too.
- **Kill announcements and a scoreboard:** when someone is destroyed everyone sees who did it, and holding Tab shows kills and deaths (also listed in the Fly together panel).
- **Save an image:** a camera button (or the I key) saves the current view as a PNG download, with no note names in it.
- **See where you were hit from:** an arc on the screen points toward whoever hit you (blue for the shield, red for the hull), with a different sound for each.
- **Network help:** each pilot's ping shows in the Fly together panel, and a short "Can't connect?" checklist appears after a failed connection.
- **Quality setting:** Automatic, Low, Balanced or High, for slower computers or sharper screens.
- **Optional update notice (off by default):** a once-a-day check of GitHub's releases for a newer version, with a link. Nothing is installed, and it is the only network use outside a room, so it stays off unless you turn it on.
- **Powerups, missiles and meteors:** pickups float in the sky (missile, shield cell, overdrive). A missile that hits a folded group breaks it into meteors that scatter and damage any ship they hit. Everyone in a room sees the same thing, and each pilot decides whether they were hit.
- **Damage rework:** every ship now has a 40-point shield on top of a 100-point hull. Hits take the shield first and it recharges by itself after 3.5 seconds without a hit; the hull never heals, except that a kill patches it by 30 and recharges your shield. Shields show on the HUD and on other pilots' nameplates.
- **Movement balance:** everyone cruises a third faster in a room, the afterburner is a touch slower than before and drains a little faster, and does not refill for two seconds after you are hit, so a fight cannot be escaped by simply running.
- **Fix:** a pilot's nameplate no longer stays stuck where they died; it is hidden while they are destroyed and follows them when they respawn.
- **Heal on kill:** destroying another pilot gives you back 30 health.
- **Names only where you look:** while flying, only the note you are aiming at or have locked, the notes close to your ship, and the vault's centre are named.
- **Layout controls:** new Node size, Link brightness and Spacing settings (like Obsidian's own graph forces) to tidy a vault whose groups sit too tight or too far apart.
- **No more white blobs:** crowded groups now blend like screen light, so overlapping notes keep their colour instead of clipping to white.
- **A clearer view when flying:** the group list is hidden in Pilot mode.
- **Lobbies keep your notes private:** the note list and group list are put away while you are in a room.
- **Calmer stars:** distant stars dim and bright ones level off instead of clipping to white, so a room with several constellations is no longer blinding.
- **Dogfighting in a room:** same-size ships with a ring that stays visible far away, nameplates with name, health and distance, arrows to pilots off-screen, and a lead pip for aiming at a moving target.
- **Spectator mode:** N watches the other pilots; after 30 seconds without input in a room you start watching automatically, and any flight key brings you back.
- **Smoother camera:** zooming with the wheel now glides instead of stepping, and a room no longer turns the camera smoothing off. The panels no longer blur the 3D view behind them, which was costly to draw.
- A new sound engine, speed effects, folded groups (shoot one to open it, B to fold), cursor steering and an on-screen controls panel.
- The flat map was removed. The README has a new look, with screenshots.
