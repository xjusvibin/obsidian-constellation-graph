# Multiplayer service deployment

## Hosted rooms (normal player install)

The plugin's **Hosted rooms** mode connects to `wss://constellation-rooms.mrassetto.workers.dev`. Players only install the plugin, choose a name, and share an eight-character room code. This endpoint is tied to the maintainer's Cloudflare `workers.dev` subdomain.

The hosted service runs the room protocol in one Cloudflare Durable Object. Membership, host authority, and combat checkpoints stay in memory. The server uses WebRTC signaling only for setup; game traffic remains peer-to-peer or travels through TURN when NAT/firewall rules require a relay.

The relay uses Metered's TURN REST API to issue credentials that expire after one hour. The deployed maintainer account currently shows a **500 MB monthly free trial** with a hard stop at the allowance, and automatic reload is off. This is shared by all players; once it runs out, direct WebRTC can still work, while players who need a relay may be unable to connect until the allowance resets. Metered's separate 20 GB free tier currently does not expose the TURN REST API, so it cannot provide this deployment's automatic hourly credentials. Check the account's current plan and billing settings before changing it; do not enable paid overages or automatic reload. See [Open Relay](https://www.metered.ca/tools/openrelay/), [Metered TURN credential API](https://www.metered.ca/docs/turn-rest-api/post-create-credential/), and [Metered billing terms](https://www.metered.ca/terms). Cloudflare Free Durable Objects also have request and compute quotas; see [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### One-time maintainer setup

These steps are for the maintainer only. Players do not install Node.js, run commands, or create provider accounts.

1. Confirm the Cloudflare account is on Workers Free before deploying. The intended address uses the existing `mrassetto.workers.dev` subdomain. If the account is paid, deploy this service from a dedicated Free account instead of changing other services.
2. Create a Metered Open Relay app with TURN REST API access. Confirm its allowance has a hard cap and automatic reload/paid overages are disabled. The deployed app currently uses Metered's 500 MB free trial because the separate 20 GB free tier does not expose that API. Copy the app name and account Secret Key from Metered's developer settings; never put the key in source, chat, or command arguments.
3. In this directory, run `npm ci`. Authenticate Wrangler with `npx wrangler login` if it is not already signed in.
4. Add the two values as Cloudflare Worker secrets. Wrangler prompts for each value; do not paste either value into source files, chat, or shell command arguments:

   ```powershell
   npx wrangler secret put METERED_APP --config wrangler.jsonc
   npx wrangler secret put METERED_SECRET_KEY --config wrangler.jsonc
   ```

5. Run `npm run build:hosted` to validate the Worker bundle, then `npm run deploy:hosted` to publish it. Cloudflare supplies HTTPS/WSS for the `workers.dev` address; no purchased domain is required.
6. The first room request starts one-hour TURN credential provisioning. While Metered's credentials propagate (up to two minutes), the plugin tries direct connections and checks for relay credentials automatically. A cron trigger rotates credentials every 30 minutes, and the coordinator keeps only the short-lived relay configuration so it survives an idle restart. The account Secret Key never goes to clients; the service never logs provider API keys, TURN credentials, or game payloads.
7. Verify `https://constellation-rooms.mrassetto.workers.dev/health` returns `{"ok":true,"rooms":0}` when no rooms are open. Then test create/join and forced TURN with two actual Obsidian clients on different internet connections. A synthetic WebSocket check does not establish relay connectivity.

No paid plan, overage, or auto-top-up should be enabled. Free-tier quota exhaustion makes the service or relay unavailable until the provider resets the allowance; the plugin reports room-service failures and confirmed relay quota errors separately.

## Self-hosted Node.js service

The plugin uses direct WebRTC data channels for map and flight traffic. This Node.js service only creates in-memory rooms, relays WebRTC setup messages, issues short-lived TURN credentials, and keeps the host's latest small combat checkpoint so a remaining participant can take over. It does not log gameplay messages or credentials. A room and its checkpoint disappear when its last participant leaves or the service restarts.

## Docker Compose deployment

You need a Linux host with Docker Compose, a public IPv4 address, and DNS names for the signaling and TURN services. Open inbound TCP ports 80 and 443 for Caddy, TCP and UDP 3478 for TURN, TCP 5349 for TURN over TLS, and TCP and UDP ports 49160–49200 for relayed media/data. Adjust the relay range in both the firewall and Compose together if your host needs a different range.

From this directory:

1. Copy `.env.example` to `.env` and set `PUBLIC_DOMAIN` to a DNS name pointing at the host. Caddy obtains and renews HTTPS for this name; the plugin uses `wss://PUBLIC_DOMAIN` for signaling.
2. Set `TURN_REALM` to the TURN DNS name and `TURN_EXTERNAL_IP` to the host's public IPv4 address. If the host is behind NAT, configure coturn's external/private address mapping as described in the [coturn server options](https://github.com/coturn/coturn/wiki/turnserver).
3. Generate a strong shared secret (for example, `openssl rand -hex 32`) and put it in `TURN_SECRET`. Compose gives the same secret to coturn and the signaling service. The service derives TURN REST credentials that expire after one hour; the long-lived shared secret never goes to clients.
4. Place a publicly trusted `fullchain.pem` and `privkey.pem` for the TURN name in the directory selected by `TURN_TLS_CERT_DIR` (the example uses `server/certs/`). The files are mounted read-only into coturn and ignored by Git. Caddy independently manages the HTTPS certificate for `PUBLIC_DOMAIN`.
5. Confirm `TURN_URLS` names the same TURN host and ports. Keep the `turns:` URL if the certificate is configured; retain the UDP and TCP `turn:` URLs for ordinary relays.
6. Start the stack with `docker compose --env-file .env up -d --build`, then check `https://PUBLIC_DOMAIN/health`.

Select **Custom server** in plugin settings and enter `wss://PUBLIC_DOMAIN`. Both players need the same service URL, but only the room creator shares the room code with the other pilots. Do not expose the Node signaling port directly; Compose keeps it on the private bridge behind Caddy.

## Local service development

Use Node.js 20 or newer. From the repository root run `npm ci --prefix server`, then start the service in PowerShell:

```powershell
$env:PORT = "8787"
$env:TURN_SECRET = "local-development-secret"
npm --prefix server start
```

In Obsidian, select **Custom server** and enter `ws://localhost:8787` on the same computer. Local testing can use STUN only; one-hour TURN credentials are included only when both `TURN_SECRET` and `TURN_URLS` are set. There is no public credential-issuance endpoint. For internet use, serve the room endpoint over WSS and provide a reachable TURN service.

## Data and limits

- Room membership is held in memory, capped at four pilots per room. The service rate-limits room creation, connections, ICE-config requests, and signaling messages.
- The server sees room codes, display names, WebRTC offer/answer and ICE candidate messages, and the latest compact combat checkpoint. ICE candidates can reveal network addresses to the other peers, as they do in ordinary WebRTC.
- Note titles, paths, tags, and contents are never part of the plugin's network types. Vault shapes are shared as anonymous node IDs, group colors, links, and moving positions.
- Routine game inputs, ships, shots, and map positions travel over WebRTC data channels. The signaling service does not receive those snapshots. The host checkpoint contains only anonymous player IDs, flight state, health, boost, and in-flight shots.
- A WebRTC peer pair uses an ordered reliable channel for topology and an unordered, zero-retransmit channel for replaceable flight and position snapshots. Position snapshots are sequence-numbered binary chunks; incomplete, stale, or wrong-revision frames are dropped.

The synthetic tests cover protocol privacy, limits, stale snapshots, boost, hits, respawns, room capacity, Worker room creation, host election, credential rotation, provider outages, and quota classification. They do not establish public DNS, forced TURN relay, or cross-internet Obsidian connectivity.

From the repository root, `npm run check:hosted` checks the deployed WebSocket service with Obsidian's desktop Origin header. It creates an independent synthetic room, joins with a second synthetic client, reports only the relay status and server count, and disconnects both clients. It does not send vault data or make WebRTC/TURN connections, and never prints credential payloads. This verifies hosted signaling from the machine running the check; it does not verify another player's network.

`npm run harness:network` builds a browser harness that needs no vault or WebGL. It can require TURN relay, send synthetic flight inputs, and display selected candidate types without exposing addresses or credentials. Forced relay consumes the real shared allowance while its clients are connected, so disconnect after testing. See [0.3.1 verification](../docs/verification-0.3.1.md) for observed browser results and the separate Obsidian verification boundary.
