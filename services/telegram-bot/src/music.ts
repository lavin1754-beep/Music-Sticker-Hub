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

/** Write YOUTUBE_COOKIES env var to disk so yt-dlp can use it. */
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

function getCached(key: string): SearchResult[] | null {
  const e = searchCache.get(key);
  if (!e || Date.now() > e.expiresAt) { searchCache.delete(key); return null; }
  return e.results;
}
function setCache(key: string, results: SearchResult[]): void {
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL });
}

function cleanQuery(q: string): string { return q.trim().replace(/\s+/g, " "); }

export async function searchMusic(
  query: string,
  kind: "song" | "artist" | "movie" | "lyrics",
  limit = 30,
): Promise<SearchResult[]> {
  let q = cleanQuery(query);
  if (!q) return [];
  switch (kind) {
    case "song":   q = `${q} audio`; break;
    case "artist": q = `${q} top songs`; break;
    case "movie":  q = `${q} movie songs jukebox`; break;
    case "lyrics": break;
  }
  const cacheKey = `${kind}:${q}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  try {
    const videos = await YouTube.search(q, { type: "video", limit, safeSearch: false });
    const results = videos
      .filter((v) => v.id && v.title)
      .map((v) => ({
        videoId: v.id as string,
        title: v.title || "Unknown",
        url: `https://www.youtube.com/watch?v=${v.id}`,
        channel: v.channel?.name || "Unknown",
        durationFormatted: v.durationFormatted || "?",
      }));
    setCache(cacheKey, results);
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

// ─── JioSaavn download (PRIMARY — works on all cloud servers) ─────────────────
// JioSaavn is a licensed music streaming service with a public API.
// It doesn't block cloud IPs and requires no authentication.

// Strip YouTube-style suffixes to get a clean song name for JioSaavn search.
function cleanTitle(t: string): string {
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

interface SaavnSong {
  name?: string;
  duration?: number;
  artists?: { primary?: Array<{ name: string }> };
  image?: Array<{ url: string; quality: string }>;
  downloadUrl?: Array<{ url: string; quality: string }>;
}

async function downloadFromSaavn(
  titleHint: string,
  artistHint: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number; thumbUrl?: string } | null> {
  const q = encodeURIComponent(`${cleanTitle(titleHint)} ${artistHint}`.trim());
  let data: { data?: { results?: SaavnSong[] } };
  try {
    const resp = await fetch(`https://saavn.dev/api/search/songs?query=${q}&limit=5`, {
      signal: AbortSignal.timeout(10000),
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
    if (!resp.ok) throw new Error(`saavn.dev HTTP ${resp.status}`);
    data = await resp.json() as typeof data;
  } catch (err) {
    console.error("[music] saavn.dev unreachable:", (err as Error).message);
    return null;
  }

  const songs = data.data?.results ?? [];
  if (!songs.length) return null;

  const song = songs[0];
  const urls = song.downloadUrl ?? [];
  // Prefer 320kbps → 160kbps → 96kbps → whatever is available
  const best =
    urls.find((u) => u.quality === "320kbps") ??
    urls.find((u) => u.quality === "160kbps") ??
    urls.find((u) => u.quality === "96kbps") ??
    urls[urls.length - 1];

  if (!best?.url) return null;

  // Convert M4A/AAC stream to MP3 via ffmpeg
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", best.url,
      "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      outPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saavn: ${err.slice(0, 150)}`));
    });
  });

  return {
    title: song.name || titleHint,
    artist: song.artists?.primary?.[0]?.name || artistHint,
    durationSec: Number(song.duration) || 0,
    thumbUrl: song.image?.find((i) => i.quality === "500x500")?.url ?? song.image?.[0]?.url,
  };
}

// ─── yt-dlp download (FALLBACK — works where not IP-blocked) ─────────────────
function buildArgs(client: string, withCookies: boolean): string[] {
  const base = [
    "--extractor-args", `youtube:player_client=${client}`,
    "--force-ipv4", "--socket-timeout", "15", "--retries", "1",
  ];
  if (withCookies) base.push("--cookies", COOKIES_FILE);
  return base;
}

function ytDlpJson(url: string, client: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [
      "--dump-single-json", "--no-warnings", "--no-playlist",
      ...buildArgs(client, cookiesReady), url,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp(${client}): ${err.slice(0, 150)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function ytDlpDownload(url: string, out: string, client: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [
      "--no-warnings", "--no-playlist", "--no-progress",
      ...buildArgs(client, cookiesReady),
      "--fragment-retries", "1",
      "-f", "bestaudio[abr<=128]/bestaudio/best",
      "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", out, url,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp dl(${client}): ${err.slice(0, 150)}`));
    });
  });
}

// ─── Main orchestrator ────────────────────────────────────────────────────────
export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  // ── 1. JioSaavn CDN (works on any cloud server, no IP blocks) ──
  if (titleHint) {
    try {
      const meta = await downloadFromSaavn(titleHint, artistHint, finalPath);
      if (meta) {
        await fs.access(finalPath);
        console.log("[music] downloaded via JioSaavn");
        return { filePath: finalPath, webUrl: url, ...meta };
      }
    } catch (err) {
      console.error("[music] JioSaavn failed:", (err as Error).message);
    }
  }

  // ── 2. yt-dlp (works on Replit, home servers; may be blocked on cloud) ──
  const clients = ["ios", "android", "mweb"] as const;
  for (const client of clients) {
    try {
      const [info] = await Promise.all([
        ytDlpJson(url, client),
        ytDlpDownload(url, outTemplate, client),
      ]);
      await fs.access(finalPath);
      console.log(`[music] downloaded via yt-dlp client=${client}`);
      return {
        filePath: finalPath,
        title: String(info.track || info.title || titleHint || "Unknown"),
        artist: String(info.artist || info.creator || info.uploader || artistHint || "Unknown"),
        durationSec: Math.round(Number(info.duration) || 0),
        thumbUrl: info.thumbnail as string | undefined,
        webUrl: String(info.webpage_url || url),
      };
    } catch (err) {
      console.error(`[music] yt-dlp(${client}) failed:`, (err as Error).message);
    }
  }

  throw new Error("Music download failed — all sources unavailable");
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
