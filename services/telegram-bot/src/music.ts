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

/** Run a command, draining both stdout and stderr to avoid buffer deadlock. */
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
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

// ─── Source 1: JioSaavn CDN ───────────────────────────────────────────────────
// Licensed music CDN. No IP restrictions. No auth. Works on any cloud server.

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
  const q = encodeURIComponent(`${stripSuffix(titleHint)} ${artistHint}`.trim());
  let songs: SaavnSong[] = [];
  try {
    const resp = await fetch(
      `https://saavn.dev/api/search/songs?query=${q}&limit=5`,
      {
        signal: AbortSignal.timeout(12_000),
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data?: { results?: SaavnSong[] } };
    songs = data.data?.results ?? [];
  } catch (err) {
    console.error("[music] saavn.dev:", (err as Error).message);
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
    title: song.name || titleHint,
    artist: song.artists?.primary?.[0]?.name || artistHint,
    durationSec: Number(song.duration) || 0,
    thumbUrl:
      song.image?.find((i) => i.quality === "500x500")?.url ??
      song.image?.[0]?.url,
  };
}

// ─── Source 2: SoundCloud via yt-dlp ─────────────────────────────────────────
// SoundCloud does NOT block cloud IPs. yt-dlp's scsearch prefix searches &
// downloads in one step. NOTE: do NOT use --no-playlist here — it breaks search.

async function trySoundCloud(
  titleHint: string,
  artistHint: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const query = `${stripSuffix(titleHint)} ${artistHint}`.trim();
  const searchQuery = `scsearch1:${query}`;

  // Single yt-dlp call: search SoundCloud + download as MP3.
  // --print writes metadata to stdout before downloading.
  try {
    const { stdout } = await runCmd("yt-dlp", [
      "--no-warnings", "--no-progress",
      "--socket-timeout", "20", "--retries", "2",
      "--print", "%(title)s\t%(uploader)s\t%(duration)s",
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", outPath,
      searchQuery,
    ]);
    await fs.access(outPath);
    const [title = query, artist = artistHint, durStr = "0"] =
      stdout.trim().split("\t");
    return { title, artist, durationSec: Math.round(Number(durStr) || 0) };
  } catch (err) {
    console.error("[music] SoundCloud:", (err as Error).message);
    return null;
  }
}

// ─── Source 3: YouTube via yt-dlp ────────────────────────────────────────────
// Works anywhere not blocked by YouTube. On Railway without cookies, YouTube
// blocks the server IP. With YOUTUBE_COOKIES env var it works everywhere.

async function tryYouTube(
  url: string,
  outTemplate: string,
  finalPath: string,
  titleHint: string,
  artistHint: string,
): Promise<DownloadedAudio | null> {
  const clients = ["ios", "android", "mweb"] as const;
  for (const client of clients) {
    const baseArgs = [
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4", "--socket-timeout", "15", "--retries", "1",
    ];
    if (cookiesReady) baseArgs.push("--cookies", COOKIES_FILE);

    try {
      const [{ stdout: infoRaw }] = await Promise.all([
        runCmd("yt-dlp", [
          "--dump-single-json", "--no-warnings", "--no-playlist",
          ...baseArgs, url,
        ]),
        runCmd("yt-dlp", [
          "--no-warnings", "--no-playlist", "--no-progress",
          ...baseArgs,
          "--fragment-retries", "1",
          "-f", "bestaudio[abr<=128]/bestaudio/best",
          "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
          "-o", outTemplate, url,
        ]),
      ]);
      await fs.access(finalPath);
      const info = JSON.parse(infoRaw) as Record<string, unknown>;
      console.log(`[music] yt-dlp client=${client}`);
      return {
        filePath: finalPath,
        title: String(info.track || info.title || titleHint || "Unknown"),
        artist: String(
          info.artist || info.creator || info.uploader || artistHint || "Unknown",
        ),
        durationSec: Math.round(Number(info.duration) || 0),
        thumbUrl: info.thumbnail as string | undefined,
        webUrl: String(info.webpage_url || url),
      };
    } catch (err) {
      console.error(`[music] yt-dlp(${client}):`, (err as Error).message);
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

  // 1️⃣ JioSaavn CDN — fastest, zero IP blocks anywhere
  if (titleHint) {
    try {
      const meta = await tryJioSaavn(titleHint, artistHint, finalPath);
      if (meta) {
        console.log("[music] ✓ JioSaavn");
        return { filePath: finalPath, webUrl: url, ...meta };
      }
    } catch (err) {
      console.error("[music] JioSaavn outer:", (err as Error).message);
    }
  }

  // 2️⃣ SoundCloud via yt-dlp — works on all cloud servers, no IP block
  if (titleHint) {
    try {
      const meta = await trySoundCloud(titleHint, artistHint, finalPath);
      if (meta) {
        console.log("[music] ✓ SoundCloud");
        return { filePath: finalPath, webUrl: url, ...meta };
      }
    } catch (err) {
      console.error("[music] SoundCloud outer:", (err as Error).message);
    }
  }

  // 3️⃣ YouTube yt-dlp — works locally and with cookies
  const result = await tryYouTube(url, outTemplate, finalPath, titleHint, artistHint);
  if (result) return result;

  throw new Error(
    "All music sources failed.\n" +
      "On Railway: add YOUTUBE_COOKIES env var as a backup, or check Railway logs.",
  );
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
