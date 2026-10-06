# Republic Battles

A browser territory-conquest strategy game. Grow your nation, take land from rival nations, and
**draw the area you want to invade** instead of clicking a border. Built mobile-first with Apple Pencil support.

Written from scratch (TypeScript, Node, WebSocket, Canvas). MIT licensed.

## Play

- **Solo** against 1–20 nation bots, or **create a private lobby** and share the 5-letter code.
- **Radial menu:** tap any land with no tool active and a ring of round buttons opens around your finger. On your own land: Economy / Military build rings (pixel icons and costs), Wall, Rail. On neutral land: Expand (quick attack) and Missile. On a rival: Attack, Missile, Ally, Embargo. On an ally: give troops or gold, or break the alliance. Tap the centre to go back or close; Esc also closes it.
- **Invade:** drag to lasso an area of enemy or neutral land that touches your border. Your troops commit to that area only,
  scaled by the *Troops per attack* slider.
- **Build:** Bunker (defence), Barracks (cheaper attacks), Bank (gold), Radar (shows enemy attack fronts), Tank Factory.
- **Tanks:** train at a factory, tap one to select, then draw its route (or tap a spot). Tanks make your attacks nearby cheaper and break enemy walls; they can't cross water or mountains and die on enemy land.
- **Aircraft:** an Airbase trains Fighters (kill enemy aircraft nearby) and Bombers (3 bombs each: they wreck enemy structures and walls under them and cut the defender's troops; they fly home to rearm). Aircraft fly over water and mountains. SAM Launchers shoot down enemy aircraft in range.
- **Walls:** press Wall, then draw a line on your own flat land. Attacks can't capture wall tiles until a tank breaks them. Hover or tap a
  structure to see its range ring.

### Controls

| Input | Draw invade | Pan | Zoom |
|---|---|---|---|
| Apple Pencil / pen | just draw (pressure scales troops, palm rejection) | one finger | pinch |
| Touch | **Draw** toggle, or long-press then drag | one finger | pinch |
| Mouse | left-drag | right/middle/shift-drag | wheel |

## Modes and features

- **Modes:** Free for all, Teams (2–6), **World War** (expand, then a Cold War countdown when a few powers hold ~70% of the land: bots stop attacking, research opens, then war resumes), and **War of the Worlds** (after the war, a dominant side researches Rocketry, builds a Spaceport and launches to a random planet with alien nations; frozen, volcanic and desert planets change the rules).
- **Co-op toggle** (lobby and solo options): every human player joins one team against the bots. Teammates can't attack each other, can't break up, share a colour family, and win together. In Teams mode the bots fill the other teams.
- **Alliances** in free-for-all (both sides must agree; bots sometimes accept) and fixed teams in team mode. Allied land cannot be attacked.
- **Buildings:** Bunker, Barracks, Bank, Radar, Port, City, Farm, Research Lab, SAM Launcher, Missile Silo, Tank Factory, Airbase, Spaceport, plus drawable Walls.
- **Units:** tanks, fighters, bombers, transports (land troops from the sea) and warships. **Missiles** from silos can be shot down by SAMs.
- **Research:** Economy, Military, Defence (and Space) branches, per player, permanent for the match.
- **Premade maps:** Earth, Europe, North America, South America, Africa, Asia and Oceania, rasterised from Natural Earth (public domain) coastlines; bots are named after countries. Mountains are synthetic. Regenerate with `node scripts/make-maps.mjs ne_50m_land.geojson`.
- **Nukes:** Atom bomb, Hydrogen bomb (big radius) and MIRV (six warheads), launched from silos, interceptable by SAMs.
- **Economy extras:** Factories, drawable Rails: draw a line from one City/Factory/Port to another and the ends snap onto nearby buildings. A connected network pays gold for every linked building, and trains shuttle along the line between the buildings it links (cosmetic), and rails can run across **allied land** to link your bases with an ally's (+50% income, shared between you; breaking the alliance cuts the line). Also automatic Trade Ships between ports (embargo-able), donating troops or gold to allies, quick chat and emoji pings.
- **Victory timers:** a clear leader triggers a 5-minute dominance countdown (lobby option); every game has a 2-hour limit.
- **Maps:** small to huge (1024×640) procedural maps, an Islands option, and custom maps from the in-browser **map editor** (`/editor.html`, Pencil supported). Publish to get a code, enter it when starting a game.
- **Pixel sprites:** 22 original 32×32 top-down sprites in `resources/sprites/` (buildings, tanks, planes, boats, missile, capital flag). Magenta pixels are recoloured to each nation's colour at runtime. Regenerate with `node scripts/make-sprites.mjs`, or replace the PNGs with your own art using the same file names (keep magenta `#FF00FF`, `#AA00AA`, `#FFAAFF` for team colour). If a PNG fails to load the game falls back to vector shapes.
- **Country image:** upload a picture that is tiled over your land.
- **Save games:** the server saves running games to `data/saves` (autosave, host's 💾 button, and on shutdown). After a restart a saved game comes back **paused** under the same lobby code; players reconnect and the host presses play.

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

`PORT` sets the port. `SAVE_DIR` and `MAPS_DIR` (default `data/saves`, `data/maps`) hold saved games and published maps; mount `data/` as a volume when using Docker. `RB_START_GOLD` (sim units, shown x100) gives everyone starting gold, handy for testing. The server serves the client and the WebSocket at `/ws` from one process.

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
- Known limits: no fog of war; trains are cosmetic (income is per network); huge maps send every change to every player (fine for LAN-size groups).
