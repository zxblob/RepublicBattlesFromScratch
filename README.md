# Republic Battles

A browser territory-conquest strategy game. Grow your nation, take land from rival nations, and
**draw the area you want to invade** instead of clicking a border. Built mobile-first with Apple Pencil support.

Written from scratch (TypeScript, Node, WebSocket, Canvas). MIT licensed.

## Play

- **Solo** against 1–20 nation bots, or **create a private lobby** and share the 5-letter code.
- **Invade:** drag to lasso an area of enemy or neutral land that touches your border. Your troops commit to that area only,
  scaled by the *Troops per attack* slider.
- **Build:** Bunker (defence), Barracks (cheaper attacks), Bank (gold), Radar (shows enemy attack fronts). Hover or tap a
  structure to see its range ring.

### Controls

| Input | Draw invade | Pan | Zoom |
|---|---|---|---|
| Apple Pencil / pen | just draw (pressure scales troops, palm rejection) | one finger | pinch |
| Touch | **Draw** toggle, or long-press then drag | one finger | pinch |
| Mouse | left-drag | right/middle/shift-drag | wheel |

## Not getting steamrolled

Nations are aggressive, but there are guard rails (all in `src/core/config.ts`):

- Defence cost per tile rises as you shrink (up to 3x).
- Your capital zone is 5x as costly to take and regenerates troops faster when you are small (last stand).
- A bot can only attack a player after a cooldown, commits fewer troops against small players, and at most 2 bots can
  target the same nation at once.

## Develop

```bash
npm install
npm run dev        # build + serve on http://localhost:3000
npm test           # simulation tests
npm run typecheck
```

`PORT` sets the port. The server serves the client and the WebSocket at `/ws` from one process.

## Self-host

```bash
docker compose up -d --build     # or: npm ci && npm run build && npm start
```

Put it behind your reverse proxy and forward WebSocket upgrades. Nginx example:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

Serving under a sub-path works too (e.g. `/battles/`): the client resolves `ws` relative to the page URL, so just proxy
that prefix to the server and strip it.

## Layout

- `src/core` deterministic simulation (map, combat, bots, structures), shared by server and client
- `src/server` HTTP + WebSocket rooms, 10 ticks/s, authoritative
- `src/client` canvas renderer, pointer/pen input, UI
- Not yet built: ships, tanks and planes, research modes, custom map creator (see roadmap in the original plan).
