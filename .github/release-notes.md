Clears the remaining findings from Obsidian's automated plugin review.

- **Settings on Obsidian 1.13 and newer** now use the declarative settings API, so they appear in Obsidian's settings search. Older versions (down to 1.7.2) keep the classic settings screen, built from the same table, so the two cannot drift apart.
- **Signed releases.** The release files are now built by GitHub Actions from the tagged source and carry a build-provenance attestation, so anyone can verify they came from this repository (`gh attestation verify main.js --repo xjusvibin/obsidian-constellation-graph`).
- No change to the graph itself.
