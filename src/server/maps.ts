import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Terrain } from "../core/mapgen";
import { unrle } from "../core/protocol";

export const MAPS_DIR = resolve(process.env.MAPS_DIR ?? "data/maps");

export interface StoredMap {
  name: string;
  w: number;
  h: number;
  /** run-length encoded terrain */
  rle: number[];
}

/** Validates an uploaded map; returns the decoded terrain or an error. */
export function validateMap(m: unknown): { terrain: Uint8Array; map: StoredMap } | string {
  const o = m as Partial<StoredMap>;
  if (!o || typeof o !== "object") return "bad map";
  const { w, h } = o;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return "bad size";
  if (w! < 64 || h! < 48 || w! > 512 || h! > 320) return "map must be between 64x48 and 512x320";
  if (!Array.isArray(o.rle) || o.rle.length % 2 !== 0 || o.rle.length > 400_000) return "bad map data";
  let total = 0;
  for (let i = 0; i < o.rle.length; i += 2) {
    const v = o.rle[i], n = o.rle[i + 1];
    if (!Number.isInteger(v) || v < 0 || v > 2 || !Number.isInteger(n) || n < 1) return "bad map data";
    total += n;
  }
  if (total !== w! * h!) return "map data does not match its size";
  const terrain = new Uint8Array(w! * h!);
  unrle(o.rle, terrain);
  let land = 0;
  for (const t of terrain) if (t !== Terrain.Water) land++;
  if (land < 400) return "a map needs at least 400 land tiles";
  const name = String(o.name ?? "Custom map").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 32) || "Custom map";
  return { terrain, map: { name, w: w!, h: h!, rle: o.rle } };
}

export async function saveMap(map: StoredMap): Promise<string> {
  await mkdir(MAPS_DIR, { recursive: true });
  const code = Array.from(randomBytes(6), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("");
  await writeFile(join(MAPS_DIR, code + ".json"), JSON.stringify(map));
  return code;
}

export async function loadMap(code: string): Promise<{ terrain: Uint8Array; map: StoredMap } | null> {
  if (!/^[A-Z0-9]{4,10}$/.test(code)) return null;
  try {
    const raw = JSON.parse(await readFile(join(MAPS_DIR, code + ".json"), "utf8"));
    const v = validateMap(raw);
    return typeof v === "string" ? null : v;
  } catch {
    return null;
  }
}
