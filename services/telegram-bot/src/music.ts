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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripYtSuffix(t: string): string {
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

function spawnPromise(
  cmd: string,
  args: string[],
  captureStdout = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    if (captureStdout) child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

// ─── Source 1: JioSaavn CDN ───────────────────────────────────────────────────
// Licensed music CDN — no IP blocking, no auth, works on any cloud server.

interface SaavnSong {
  name?: string;
  duration?: number;
  artists?: { primary?: Array<{ name: string }> };
  image?: Array<{ url: string; quality: string }>;
  downloadUrl?: Array<{ url: string; quality: string }>;
}

async function tryJioSaavn(
  titleHint: string,
  artistHint: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number; thumbUrl?: string } | null> {
  const q = encodeURIComponent(`${stripYtSuffix(titleHint)} ${artistHint}`.trim());
  let songs: SaavnSong[] = [];

  try {
    const resp = await fetch(`https://saavn.dev/api/search/songs?query=${q}&limit=5`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: { results?: SaavnSong[] } };
    songs = data.data?.results ?? [];
  } catch (err) {
    console.error("[music] saavn.dev fetch failed:", (err as Error).message);
    return null;
  }

  if (!songs.length) return null;
  const song = songs[0];
  const urls = song.downloadUrl ?? [];
  const best =
    urls.find((u) => u.quality === "320kbps") ??
    urls.find((u) => u.quality === "160kbps") ??
    urls.find((u) => u.quality === "96kbps") ??
    urls[urls.length - 1];

  if (!best?.url) return null;

  try {
    await spawnPromise("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", best.url,
      "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      outPath,
    ]);
  } catch (err) {
    console.error("[music] ffmpeg/saavn failed:", (err as Error).message);
    return null;
  }

  return {
    title: song.name || titleHint,
    artist: song.artists?.primary?.[0]?.name || artistHint,
    durationSec: Number(song.duration) || 0,
    thumbUrl:
      song.image?.find((i) => i.quality === "500x500")?.url ?? song.image?.[0]?.url,
  };
}

// ─── Source 2: SoundCloud via yt-dlp ─────────────────────────────────────────
// SoundCloud does NOT block cloud server IPs. yt-dlp's `scsearch1:` prefix
// searches SoundCloud and downloads the first match directly.

async function trySoundCloud(
  titleHint: string,
  artistHint: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const query = `${stripYtSuffix(titleHint)} ${artistHint}`.trim();
  const searchStr = `scsearch1:${query}`;

  // Fetch metadata first
  let infoJson: Record<string, unknown>;
  try {
    const raw = await spawnPromise("yt-dlp", [
      "--dump-single-json", "--no-warnings", "--no-playlist",
      "--socket-timeout", "15", "--retries", "1",
      searchStr,
    ], true);
    // yt-dlp scsearch returns a playlist wrapper — grab first entry
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = parsed.entries as Record<string, unknown>[] | undefined;
    infoJson = entries?.[0] ?? parsed;
  } catch (err) {
    console.error("[music] SoundCloud info failed:", (err as Error).message);
    return null;
  }

  const scUrl = String(infoJson.webpage_url || "");
  if (!scUrl) return null;

  // Download as MP3
  try {
    await spawnPromise("yt-dlp", [
      "--no-warnings", "--no-playlist", "--no-progress",
      "--socket-timeout", "15", "--retries", "1",
      "-f", "bestaudio/best",
      "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outPath,
      scUrl,
    ]);
    await fs.access(outPath);
  } catch (err) {
    console.error("[music] SoundCloud download failed:", (err as Error).message);
    return null;
  }

  return {
    title: String(infoJson.title || titleHint),
    artist: String(infoJson.uploader || artistHint),
    durationSec: Math.round(Number(infoJson.duration) || 0),
  };
}

// ─── Source 3: YouTube via yt-dlp ────────────────────────────────────────────
// Works on Replit / home servers. On Railway, blocked by YouTube unless
// cookies are provided via YOUTUBE_COOKIES env var.

function ytArgs(client: string): string[] {
  const args = [
    "--extractor-args", `youtube:player_client=${client}`,
    "--force-ipv4", "--socket-timeout", "15", "--retries", "1",
  ];
  if (cookiesReady) args.push("--cookies", COOKIES_FILE);
  return args;
}

async function tryYouTube(
  url: string,
  outTemplate: string,
  finalPath: string,
  titleHint: string,
  artistHint: string,
): Promise<DownloadedAudio | null> {
  for (const client of ["ios", "android", "mweb"] as const) {
    try {
      const [rawInfo] = await Promise.all([
        spawnPromise("yt-dlp", [
          "--dump-single-json", "--no-warnings", "--no-playlist",
          ...ytArgs(client), url,
        ], true),
        spawnPromise("yt-dlp", [
          "--no-warnings", "--no-playlist", "--no-progress",
          ...ytArgs(client),
          "--fragment-retries", "1",
          "-f", "bestaudio[abr<=128]/bestaudio/best",
          "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
          "-o", outTemplate, url,
        ]),
      ]);
      await fs.access(finalPath);
      const info = JSON.parse(rawInfo) as Record<string, unknown>;
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
  const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  // ── 1. JioSaavn CDN (fastest, works on all cloud servers) ──
  if (titleHint) {
    try {
      const meta = await tryJioSaavn(titleHint, artistHint, finalPath);
      if (meta) {
        await fs.access(finalPath);
        console.log("[music] downloaded via JioSaavn");
        return { filePath: finalPath, webUrl: url, ...meta };
      }
    } catch (err) {
      console.error("[music] JioSaavn error:", (err as Error).message);
    }
  }

  // ── 2. SoundCloud via yt-dlp (cloud-friendly, no IP blocks) ──
  if (titleHint) {
    try {
      const meta = await trySoundCloud(titleHint, artistHint, finalPath);
      if (meta) {
        console.log("[music] downloaded via SoundCloud");
        return { filePath: finalPath, webUrl: url, ...meta };
      }
    } catch (err) {
      console.error("[music] SoundCloud error:", (err as Error).message);
    }
  }

  // ── 3. YouTube via yt-dlp (works locally / with cookies) ──
  const result = await tryYouTube(url, outTemplate, finalPath, titleHint, artistHint);
  if (result) return result;

  throw new Error(
    "Music download failed — YouTube is blocking this server's IP.\n" +
    "Fix: add YOUTUBE_COOKIES to Railway environment variables.",
  );
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
