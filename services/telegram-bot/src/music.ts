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

interface CacheEntry { results: SearchResult[]; expiresAt: number }
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(k: string): SearchResult[] | null {
  const e = searchCache.get(k);
  if (!e || Date.now() > e.expiresAt) {
    searchCache.delete(k);
    return null;
  }
  return e.results;
}

function setCache(k: string, r: SearchResult[]): void {
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value!);
  searchCache.set(k, { results: r, expiresAt: Date.now() + CACHE_TTL });
}

export async function searchMusic(
  query: string,
  kind: "song" | "artist" | "movie" | "lyrics",
  limit = 100,
): Promise<SearchResult[]> {
  let q = query.trim().replace(/\s+/g, " ");
  if (!q) return [];
  switch (kind) {
    case "song": q += " audio"; break;
    case "artist": q += " top songs"; break;
    case "movie": q += " movie songs jukebox"; break;
    case "lyrics": break;
  }
  const key = `${kind}:${q}`;
  const cached = getCached(key);
  if (cached) return cached;
  try {
    const vids = await YouTube.search(q, { type: "video", limit, safeSearch: false });
    const results = vids.filter((v) => v.id && v.title).map((v) => ({
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

async function findAndMoveMp3(outDir: string, prefix: string, finalPath: string): Promise<boolean> {
  const expected = path.join(outDir, `${prefix}.mp3`);
  try {
    await fs.access(expected);
    if (expected !== finalPath) await fs.rename(expected, finalPath);
    return true;
  } catch {
  }
  const files = await fs.readdir(outDir);
  const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".mp3"));
  if (match) {
    await fs.rename(path.join(outDir, match), finalPath);
    return true;
  }
  return false;
}

async function tryYouTubeDirect(url: string, outPath: string): Promise<boolean> {
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
      if (await findAndMoveMp3(outDir, prefix, outPath)) return true;
    } catch (err) {
      console.error(`[music] ytdirect(${client}):`, (err as Error).message);
    }
  }
  return false;
}

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
  "https://jiosaavan-harsh.vercel.app/api/search/songs",
];

async function tryJioSaavn(title: string, artist: string, outPath: string): Promise<{ title: string; artist: string; durationSec: number; thumbUrl?: string } | null> {
  const q = encodeURIComponent(`${title} ${artist}`.trim());
  let song: SaavnSong | null = null;
  for (const base of SAAVN_APIS) {
    try {
      const resp = await fetch(`${base}?query=${q}&limit=3`, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (!text || text.startsWith("<")) continue;
      const data = JSON.parse(text) as { data?: { results?: SaavnSong[] } };
      const results = data.data?.results ?? [];
      if (results.length) { song = results[0]; break; }
    } catch {
    }
  }
  if (!song) return null;
  const urls = song.downloadUrl ?? [];
  const best = urls.find((u) => u.quality === "320kbps") ?? urls.find((u) => u.quality === "160kbps") ?? urls[urls.length - 1];
  if (!best?.url) return null;
  try {
    await runCmd("ffmpeg", ["-y", "-loglevel", "error", "-i", best.url, "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k", outPath]);
    await fs.access(outPath);
  } catch {
    return null;
  }
  return { title: song.name || title, artist: song.artists?.primary?.[0]?.name || artist, durationSec: Number(song.duration) || 0, thumbUrl: song.image?.[0]?.url };
}

async function trySoundCloud(title: string, artist: string, outPath: string): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const q = `${title} ${artist}`.trim();
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-sc";
  try {
    const { stdout } = await runCmd("yt-dlp", ["--no-warnings", "--flat-playlist", "--print", "%(webpage_url)s", `scsearch1:${q}`]);
    const line = stdout.trim().split("\n")[0] ?? "";
    if (!line.startsWith("https://soundcloud.com/")) return null;
    await runCmd("yt-dlp", ["--no-warnings", "--no-progress", "--socket-timeout", "30", "--concurrent-fragments", "5", "-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", path.join(outDir, `${prefix}.%(ext)s`), line]);
    if (await findAndMoveMp3(outDir, prefix, outPath)) return { title, artist, durationSec: 0 };
  } catch {
    return null;
  }
  return null;
}

export async function debugSources(): Promise<string> {
  const lines: string[] = [];
  const ytdlpVersion = await runCmd("yt-dlp", ["--version"]).then((r) => r.stdout.trim()).catch(() => "NOT FOUND");
  const ffmpegOk = await runCmd("ffmpeg", ["-version"]).then(() => "OK").catch(() => "NOT FOUND");
  lines.push(`yt-dlp: ${ytdlpVersion}`);
  lines.push(`ffmpeg: ${ffmpegOk}`);
  lines.push(`cookies: ${cookiesReady ? "yes" : "no"}`);
  return lines.join("\n");
}

export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
  videoId = "",
): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);
  const directUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  if (await tryYouTubeDirect(directUrl, finalPath)) return { filePath: finalPath, webUrl: url, title: titleHint || "Selected track", artist: artistHint || "YouTube", durationSec: 0 };
  if (videoId) throw new Error("Exact selected video download failed");
  const sc = await trySoundCloud(titleHint, artistHint, finalPath);
  if (sc) return { filePath: finalPath, webUrl: url, ...sc };
  const jio = await tryJioSaavn(titleHint, artistHint, finalPath);
  if (jio) return { filePath: finalPath, webUrl: url, ...jio };
  const fallback = await tryYouTubeDirect(url, finalPath);
  if (fallback) return { filePath: finalPath, webUrl: url, title: titleHint || "Selected track", artist: artistHint || "YouTube", durationSec: 0 };
  throw new Error("All music sources failed");
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { }
}
