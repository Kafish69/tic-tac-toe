# tic · tac · toe

Online tic tac toe for two people. One person creates a room, shares the 6-letter code (or link), and you're playing live, on phone or laptop.

**Modes:** Classic · Vanish (3 marks max, oldest disappears) · Misère (make three and you lose) · Big Board (5×5, four in a row) · Ultimate (9 boards in one)

Also: running score, rematch (the starting player alternates), emoji reactions, sound and haptics, and a "Play on one phone" mode.

## Going live on GitHub Pages
1. Create a new public repo named `tic-tac-toe`.
2. Upload **everything in this folder** (including `.nojekyll`, `vendor/` and `js/`) to the root of the repo.
3. Go to Settings → Pages → Source: *Deploy from a branch* → Branch: `main` / `(root)` → Save.
4. After about a minute it's live at `https://<your-username>.github.io/tic-tac-toe/`

## How online works (no server needed)
There's no backend. Moves go through three free public MQTT relays (HiveMQ, EMQX, Mosquitto) **at the same time**, and duplicate messages are dropped. If one relay is down or blocked on a network, the game keeps working through the others. The latest game state stays saved on the relays, so if either player refreshes or loses signal, the game picks up where it left off.

## Files
- `index.html`, `style.css`: the UI
- `js/engine.js`: the game rules for all modes (no DOM, no network)
- `js/net.js`: the relay layer
- `js/app.js`: the app logic
- `vendor/mqtt.min.js`: MQTT.js v5.16.1, bundled so the game doesn't depend on a CDN
