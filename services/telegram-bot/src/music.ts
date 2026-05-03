import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { YouTube } from "youtube-sr";
import type { SearchResult } from "./state.js";

const TMP_DIR = path.join(os.tmpdir(), "arya-music");
const COOKIES_FILE = path.join(os.tmpdir(), "yt-cookies.txt");
let cookiesReady = false;

async function ensureTmp(): Promise<void> {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

export async function initCookies(): Promise<void> {
  const raw = process.env.YOUTUBE_COOKIES;
  if (!raw || raw.trim().length < 10) return;
  try {
    await fs.writeFile(COOKIES_FILE, raw.trim(), "utf8");
    cookiesReady = true;
    console.log("[music] YouTube cookies loaded");
  } catch (err) {
    console.error("[music] Failed to write cookies:", err);
  }
}

// ─── Search cache ─────────────────────────────────────────────────────────────
interface CacheEntry { results: SearchResult[]; expiresAt: number }
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(k: string): SearchResult[] | null {
  const e = searchCache.get(k);
  if (!e || Date.now() > e.expiresAt) { searchCache.delete(k); return null; }
  return e.results;
}
function setCache(k: string, r: SearchResult[]): void {
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(k, { results: r, expiresAt: Date.now() + CACHE_TTL });
}

export async function searchMusic(
  query: string,
  kind: "song" | "artist" | "movie" | "lyrics",
  limit = 30,
): Promise<SearchResult[]> {
  let q = query.trim().replace(/\s+/g, " ");
  if (!q) return [];
  switch (kind) {
    case "song":   q += " audio"; break;
    case "artist": q += " top songs"; break;
    case "movie":  q += " movie songs jukebox"; break;
    case "lyrics": break;
  }
  const key = `${kind}:${q}`;
  const cached = getCached(key);
  if (cached) return cached;
  try {
    const vids = await YouTube.search(q, { type: "video", limit, safeSearch: false });
    const results = vids
      .filter((v) => v.id && v.title)
      .map((v) => ({
        videoId: v.id as string,
        title: v.title || "Unknown",
        url: `https://www.youtube.com/watch?v=${v.id}`,
        channel: v.channel?.name || "Unknown",
        durationFormatted: v.durationFormatted || "?",
      }));
    setCache(key, results);
    return results;
  } catch (err) {
    console.error("[music] search failed", err);
    return [];
  }
}

export interface DownloadedAudio {
  filePath: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbUrl?: string;
  webUrl: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripSuffix(t: string): string {
  return t
    .replace(/\(official\s*(music\s*)?video\)/gi, "")
    .replace(/\(official\s*audio\)/gi, "")
    .replace(/\|\s*official\s*(audio|video)/gi, "")
    .replace(/\(lyric\s*video\)/gi, "")
    .replace(/\(\d+K?\s*remaster.*?\)/gi, "")
    .replace(/\(full\s*song\)/gi, "")
    .replace(/\(audio\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Run a command, draining BOTH stdout and stderr to avoid buffer deadlock. */
function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`));
    });
  });
}

/** After a yt-dlp download, find the resulting .mp3 file by prefix. */
async function findMp3(outDir: string, prefix: string, finalPath: string): Promise<boolean> {
  // Direct hit (yt-dlp honoured the %(ext)s template)
  const expected = path.join(outDir, `${prefix}.mp3`);
  try {
    await fs.access(expected);
    if (expected !== finalPath) await fs.rename(expected, finalPath);
    return true;
  } catch { /* fall through */ }

  // Scan directory for any file starting with the prefix
  const files = await fs.readdir(outDir);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".mp3"));
  if (match) {
    await fs.rename(path.join(outDir, match), finalPath);
    return true;
  }
  return false;
}

// ─── Source 1: JioSaavn CDN ───────────────────────────────────────────────────
// Licensed music CDN. Works on Railway (no cloud IP restrictions).
// Not accessible from Replit's network (DNS blocked).

interface SaavnSong {
  name?: string;
  duration?: number;
  artists?: { primary?: Array<{ name: string }> };
  image?: Array<{ url: string; quality: string }>;
  downloadUrl?: Array<{ url: string; quality: string }>;
}

const SAAVN_APIS = [
  "https://saavn.dev/api/search/songs",
  "https://saavn.me/api/search/songs",
];

async function tryJioSaavn(
  title: string,
  artist: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number; thumbUrl?: string } | null> {
  const q = encodeURIComponent(`${stripSuffix(title)} ${artist}`.trim());
  let song: SaavnSong | null = null;

  for (const base of SAAVN_APIS) {
    try {
      const resp = await fetch(`${base}?query=${q}&limit=3`, {
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text || text.length < 10) continue;
      const data = JSON.parse(text) as { data?: { results?: SaavnSong[] } };
      const results = data.data?.results ?? [];
      if (results.length) { song = results[0]; break; }
    } catch { /* try next mirror */ }
  }

  if (!song) return null;

  const urls = song.downloadUrl ?? [];
  const best =
    urls.find((u) => u.quality === "320kbps") ??
    urls.find((u) => u.quality === "160kbps") ??
    urls.find((u) => u.quality === "96kbps") ??
    urls[urls.length - 1];
  if (!best?.url) return null;

  try {
    await runCmd("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", best.url,
      "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      outPath,
    ]);
    await fs.access(outPath);
  } catch (err) {
    console.error("[music] saavn ffmpeg:", (err as Error).message);
    return null;
  }

  return {
    title: song.name || title,
    artist: song.artists?.primary?.[0]?.name || artist,
    durationSec: Number(song.duration) || 0,
    thumbUrl:
      song.image?.find((i) => i.quality === "500x500")?.url ?? song.image?.[0]?.url,
  };
}

// ─── Source 2: yt-dlp via ytsearch + iOS client ───────────────────────────────
// Searches YouTube by song name and downloads using the iOS player API
// (HLS/m3u8). CONFIRMED WORKING on Replit. iOS client uses different
// API endpoints that are less aggressively blocked than the web client.

async function tryYtSearch(
  title: string,
  artist: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const q = `${stripSuffix(title)} ${artist}`.trim();
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-yts";

  for (const client of ["ios", "android", "mweb"] as const) {
    const args = [
      "--no-warnings", "--no-progress",
      "--socket-timeout", "20", "--retries", "1",
      "--concurrent-fragments", "5",
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4",
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", path.join(outDir, `${prefix}.%(ext)s`),
      `ytsearch1:${q}`,
    ];
    if (cookiesReady) args.push("--cookies", COOKIES_FILE);

    try {
      await runCmd("yt-dlp", args);
      if (await findMp3(outDir, prefix, outPath)) {
        console.log(`[music] ✓ ytsearch(${client})`);
        return { title, artist, durationSec: 0 };
      }
    } catch (err) {
      console.error(`[music] ytsearch(${client}):`, (err as Error).message);
    }
  }
  return null;
}

// ─── Source 3: SoundCloud via yt-dlp ─────────────────────────────────────────
// SoundCloud does not block cloud IPs. Works on Railway when yt-dlp
// is a version that correctly handles scsearch (newer than 2025.06.30).

async function trySoundCloud(
  title: string,
  artist: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const q = `${stripSuffix(title)} ${artist}`.trim();
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-sc";

  try {
    await runCmd("yt-dlp", [
      "--no-warnings", "--no-progress",
      "--socket-timeout", "30",
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", path.join(outDir, `${prefix}.%(ext)s`),
      `scsearch1:${q}`,
    ]);
    if (await findMp3(outDir, prefix, outPath)) {
      console.log("[music] ✓ SoundCloud");
      return { title, artist, durationSec: 0 };
    }
  } catch (err) {
    console.error("[music] SoundCloud:", (err as Error).message);
  }
  return null;
}

// ─── Source 4: Direct YouTube URL via yt-dlp ─────────────────────────────────
// Uses the YouTube URL from search results. Tries ios→android→mweb clients.
// Works on Replit; blocked by YouTube on Railway datacenter IPs.

async function tryYouTubeDirect(
  url: string,
  outPath: string,
  title: string,
  artist: string,
): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-ytd";

  for (const client of ["ios", "android", "mweb"] as const) {
    const args = [
      "--no-warnings", "--no-playlist", "--no-progress",
      "--socket-timeout", "15", "--retries", "1",
      "--fragment-retries", "1",
      "--concurrent-fragments", "5",
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4",
      "-f", "bestaudio[abr<=128]/bestaudio/best",
      "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", path.join(outDir, `${prefix}.%(ext)s`),
      url,
    ];
    if (cookiesReady) args.push("--cookies", COOKIES_FILE);

    try {
      await runCmd("yt-dlp", args);
      if (await findMp3(outDir, prefix, outPath)) {
        console.log(`[music] ✓ ytdirect(${client})`);
        return { title, artist, durationSec: 0 };
      }
    } catch (err) {
      console.error(`[music] ytdirect(${client}):`, (err as Error).message);
    }
  }
  return null;
}

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  // 1️⃣ JioSaavn CDN — works on Railway (licensed, no IP block)
  if (titleHint) {
    try {
      const m = await tryJioSaavn(titleHint, artistHint, finalPath);
      if (m) return { filePath: finalPath, webUrl: url, ...m };
    } catch (e) { console.error("[music] JioSaavn:", (e as Error).message); }
  }

  // 2️⃣ YouTube search via iOS client — CONFIRMED working (HLS path)
  if (titleHint) {
    try {
      const m = await tryYtSearch(titleHint, artistHint, finalPath);
      if (m) return { filePath: finalPath, webUrl: url, ...m };
    } catch (e) { console.error("[music] ytSearch:", (e as Error).message); }
  }

  // 3️⃣ SoundCloud — works on Railway with newer yt-dlp
  if (titleHint) {
    try {
      const m = await trySoundCloud(titleHint, artistHint, finalPath);
      if (m) return { filePath: finalPath, webUrl: url, ...m };
    } catch (e) { console.error("[music] SoundCloud:", (e as Error).message); }
  }

  // 4️⃣ Direct YouTube URL — fallback for any server where YouTube isn't blocked
  {
    const m = await tryYouTubeDirect(url, finalPath, titleHint, artistHint);
    if (m) return { filePath: finalPath, webUrl: url, ...m };
  }

  throw new Error("All music sources failed. Check Railway logs for details.");
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
