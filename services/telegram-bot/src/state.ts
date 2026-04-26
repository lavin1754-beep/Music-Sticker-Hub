import { promises as fs } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "services/telegram-bot/data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PACKS_FILE = path.join(DATA_DIR, "packs.json");

export type Mode = "music" | "sticker" | null;

export interface SearchResult {
  title: string;
  url: string;
  channel: string;
  durationFormatted: string;
}

export interface UserState {
  mode: Mode;
  step: string;
  data: Record<string, unknown>;
  history: Array<{ mode: Mode; step: string }>;
  searchResults?: SearchResult[];
  searchPage?: number;
  searchQuery?: string;
  searchKind?: "song" | "artist" | "movie" | "lyrics";
  pendingPackName?: string;
  currentPackShortName?: string;
  lastMenuMessageId?: number;
}

export interface PackRecord {
  name: string;
  shortName: string;
  link: string;
  kind: "static" | "video";
  count: number;
  createdAt: number;
}

interface UserPacks {
  currentPackShortName?: string;
  packs: PackRecord[];
}

let states: Record<string, UserState> = {};
let packs: Record<string, UserPacks> = {};
let saveTimer: NodeJS.Timeout | null = null;

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadStore(): Promise<void> {
  await ensureDir();
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    states = JSON.parse(raw);
  } catch {
    states = {};
  }
  try {
    const raw = await fs.readFile(PACKS_FILE, "utf8");
    packs = JSON.parse(raw);
  } catch {
    packs = {};
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await ensureDir();
      await fs.writeFile(STATE_FILE, JSON.stringify(states), "utf8");
      await fs.writeFile(PACKS_FILE, JSON.stringify(packs), "utf8");
    } catch (err) {
      console.error("[state] save failed", err);
    }
  }, 250);
}

function emptyState(): UserState {
  return { mode: null, step: "idle", data: {}, history: [] };
}

export function getState(userId: number | string): UserState {
  const id = String(userId);
  if (!states[id]) states[id] = emptyState();
  return states[id];
}

export function setState(userId: number | string, partial: Partial<UserState>): UserState {
  const cur = getState(userId);
  const next = { ...cur, ...partial };
  states[String(userId)] = next;
  scheduleSave();
  return next;
}

export function pushHistory(userId: number | string): void {
  const s = getState(userId);
  s.history.push({ mode: s.mode, step: s.step });
  if (s.history.length > 12) s.history.shift();
  scheduleSave();
}

export function popHistory(userId: number | string): { mode: Mode; step: string } | null {
  const s = getState(userId);
  return s.history.pop() ?? null;
}

export function resetState(userId: number | string): void {
  states[String(userId)] = emptyState();
  scheduleSave();
}

export function getUserPacks(userId: number | string): UserPacks {
  const id = String(userId);
  if (!packs[id]) packs[id] = { packs: [] };
  return packs[id];
}

export function addPack(userId: number | string, pack: PackRecord): void {
  const u = getUserPacks(userId);
  u.packs.push(pack);
  u.currentPackShortName = pack.shortName;
  scheduleSave();
}

export function findPack(userId: number | string, shortName: string): PackRecord | undefined {
  return getUserPacks(userId).packs.find((p) => p.shortName === shortName);
}

export function setCurrentPack(userId: number | string, shortName: string | undefined): void {
  const u = getUserPacks(userId);
  u.currentPackShortName = shortName;
  scheduleSave();
}

export function incrementPackCount(userId: number | string, shortName: string): void {
  const pack = findPack(userId, shortName);
  if (pack) {
    pack.count += 1;
    scheduleSave();
  }
}
