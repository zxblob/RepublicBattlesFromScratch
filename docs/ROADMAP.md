# Roadmap (decisions agreed with the owner)

Order: attack-feel/range polish → units → World War mode → persistence → naval → map creator → War of the Worlds.

## Units (Tank Factory, Airbase)
- Control: select a unit, then draw a path or tap a target (finger or Pencil).
- Tanks: mobile Barracks-style conquest bonus; can destroy walls. They **cannot** break mountains (permanent).
- **Walls:** drawn segments on your land, gold per tile. Enemies cannot conquer wall tiles until a tank breaches them.
- Airbase → Fighter (duels aircraft) and Bomber (area damage). SAM-style interception is shared.
- Art: placeholder vector shapes, readable when zoomed out; owner drops 32x32 transparent PNGs into a documented folder.
  Do not copy third-party sprites.

## World War mode
- Peace phase starts dynamically: top 3–6 nations own >= 70% of land, held ~30 s (all thresholds are lobby settings).
- Bots become non-aggressive during a countdown; research points come from land + banks.
- Research: 3 branches (Economy, Military, Defence), 4–5 nodes each, per player, permanent for the match.

## Persistence
- Paused games are snapshotted to disk on pause/shutdown and reloaded on restart.

## Naval
- Warships and transports after units and World War mode.

## Map creator
- Paint terrain on a grid in the browser (Pencil supported), publish with a code, pick it in the lobby.

## War of the Worlds
- The winning team of World War races to space; planets are extra maps with their own rules and a second research tier.
