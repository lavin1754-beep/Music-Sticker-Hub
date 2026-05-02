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

/** Run a command, draining BOTH stdout and stderr (avoids buffer deadlock). */
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
// Try multiple public JioSaavn API mirrors — if one is down, try the next.

interface SaavnSong {
  name?: string;
  duration?: number;
  artists?: { primary?: Array<{ name: string }> };
  image?: Array<{ url: string; quality: string }>;
  downloadUrl?: Array<{ url: string; quality: string }>;
}

const SAAVN_APIS = [
  "https://saavn.dev/api/search/songs",
  "https://jiosaavn-api-privatecvc2.vercel.app/search/songs",
];

async function fetchSaavnSong(title: string, artist: string): Promise<SaavnSong | null> {
  const q = encodeURIComponent(`${stripSuffix(title)} ${artist}`.trim());
  for (const base of SAAVN_APIS) {
    try {
      const resp = await fetch(`${base}?query=${q}&limit=5`, {
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text || text.length < 10) continue;
      const data = JSON.parse(text) as { data?: { results?: SaavnSong[] } };
      const songs = data.data?.results ?? [];
      if (songs.length) return songs[0];
    } catch {
      // try next mirror
    }
  }
  return null;
}

async function tryJioSaavn(
  title: string,
  artist: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number; thumbUrl?: string } | null> {
  const song = await fetchSaavnSong(title, artist);
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

// ─── Source 2: SoundCloud via yt-dlp ─────────────────────────────────────────
// SoundCloud never blocks cloud IPs. Use scsearch1: to search + download.
// IMPORTANT: use %(ext)s template (not a literal .mp3 path) so yt-dlp can
// manage the temp filename during conversion, then rename to the final path.

async function trySoundCloud(
  title: string,
  artist: string,
  outPath: string,
): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const q = `${stripSuffix(title)} ${artist}`.trim();
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-sc";
  // Let yt-dlp name the file itself (%(ext)s will become mp3 after -x)
  const template = path.join(outDir, `${prefix}.%(ext)s`);

  try {
    await runCmd("yt-dlp", [
      "--no-warnings", "--no-progress",
      "--socket-timeout", "30",
      "-x", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", template,
      `scsearch1:${q}`,
    ]);
  } catch (err) {
    console.error("[music] SoundCloud yt-dlp:", (err as Error).message);
    return null;
  }

  // Find the resulting file — after conversion it should be prefix.mp3
  const expectedPath = path.join(outDir, `${prefix}.mp3`);
  let foundPath: string | null = null;
  try {
    await fs.access(expectedPath);
    foundPath = expectedPath;
  } catch {
    // Scan dir for any file that starts with our prefix
    const files = await fs.readdir(outDir);
    const match = files.find((f) => f.startsWith(prefix));
    if (match) foundPath = path.join(outDir, match);
  }

  if (!foundPath) {
    console.error("[music] SoundCloud: output file not found after download");
    return null;
  }

  // Rename to the caller's expected path
  if (foundPath !== outPath) await fs.rename(foundPath, outPath);
  return { title, artist, durationSec: 0 };
}

// ─── Source 3: YouTube via yt-dlp ────────────────────────────────────────────

async function tryYouTube(
  url: string,
  outTemplate: string,
  finalPath: string,
  title: string,
  artist: string,
): Promise<DownloadedAudio | null> {
  for (const client of ["ios", "android", "mweb"] as const) {
    const base = [
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4", "--socket-timeout", "15", "--retries", "1",
    ];
    if (cookiesReady) base.push("--cookies", COOKIES_FILE);
    try {
      const [{ stdout: raw }] = await Promise.all([
        runCmd("yt-dlp", ["--dump-single-json", "--no-warnings", "--no-playlist", ...base, url]),
        runCmd("yt-dlp", [
          "--no-warnings", "--no-playlist", "--no-progress", ...base,
          "--fragment-retries", "1",
          "-f", "bestaudio[abr<=128]/bestaudio/best",
          "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
          "-o", outTemplate, url,
        ]),
      ]);
      await fs.access(finalPath);
      const info = JSON.parse(raw) as Record<string, unknown>;
      console.log(`[music] ✓ yt-dlp(${client})`);
      return {
        filePath: finalPath,
        title: String(info.track || info.title || title),
        artist: String(info.artist || info.creator || info.uploader || artist),
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
  const ytTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  // 1️⃣ JioSaavn CDN — licensed music, no IP blocks (tries multiple mirrors)
  if (titleHint) {
    try {
      const meta = await tryJioSaavn(titleHint, artistHint, finalPath);
      if (meta) { console.log("[music] ✓ JioSaavn"); return { filePath: finalPath, webUrl: url, ...meta }; }
    } catch (e) { console.error("[music] JioSaavn:", (e as Error).message); }
  }

  // 2️⃣ SoundCloud — never blocks cloud IPs, huge catalog
  if (titleHint) {
    try {
      const meta = await trySoundCloud(titleHint, artistHint, finalPath);
      if (meta) { console.log("[music] ✓ SoundCloud"); return { filePath: finalPath, webUrl: url, ...meta }; }
    } catch (e) { console.error("[music] SoundCloud:", (e as Error).message); }
  }

  // 3️⃣ YouTube via yt-dlp (works locally / with YOUTUBE_COOKIES on Railway)
  const result = await tryYouTube(url, ytTemplate, finalPath, titleHint, artistHint);
  if (result) return result;

  throw new Error(
    "All music sources failed. If you're on Railway, please check the deployment logs.",
  );
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
