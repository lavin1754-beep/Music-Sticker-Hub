import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { SearchResult } from "./state.js";

const TMP_DIR = path.join(os.tmpdir(), "arya-music");

async function ensureTmp(): Promise<void> {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

export async function initCookies(): Promise<void> {
  return;
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
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

async function searchViaYtDlp(query: string, limit: number): Promise<SearchResult[]> {
  console.log(`[search] using yt-dlp for: ${query}`);
  try {
    const args = [
      "--no-warnings",
      "--flat-playlist",
      "--dump-json",
      "--default-search", "ytsearch",
      "-f", "best",
      `ytsearch${limit}:${query}`,
    ];
    const { stdout } = await runCmd("yt-dlp", args);
    const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
    const results: SearchResult[] = [];
    
    for (const line of lines) {
      try {
        const item = JSON.parse(line) as any;
        const videoId = item.id || "";
        const title = item.title || "Unknown";
        const channel = item.uploader || "Unknown";
        const duration = item.duration || 0;
        
        if (!videoId) continue;
        
        results.push({
          videoId,
          title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          channel,
          durationFormatted: duration > 0 ? new Date(duration * 1000).toISOString().slice(14, 19) : "?",
        });
      } catch {
      }
    }
    
    console.log(`[search] yt-dlp returned ${results.length} results`);
    return results;
  } catch (err) {
    console.error("[search] yt-dlp failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
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
  if (cached) {
    console.log(`[search] cache hit for ${key}`);
    return cached;
  }
  
  try {
    const results = await searchViaYtDlp(q, Math.min(limit, 50));
    if (results.length > 0) {
      setCache(key, results);
      return results;
    }
    console.warn(`[search] no results for: ${q}`);
    return [];
  } catch (err) {
    console.error("[search] failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export interface DownloadedAudio {
  filePath: string;
  title: string;
  artist: string;
  durationSec: number;
  webUrl: string;
}

async function findAndMoveMp3(outDir: string, prefix: string, finalPath: string): Promise<boolean> {
  const expected = path.join(outDir, `${prefix}.mp3`);
  try {
    await fs.access(expected);
    if (expected !== finalPath) await fs.rename(expected, finalPath);
    return true;
  } catch {
  }
  try {
    const files = await fs.readdir(outDir);
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".mp3"));
    if (match) {
      await fs.rename(path.join(outDir, match), finalPath);
      return true;
    }
  } catch {
  }
  return false;
}

async function tryYouTubeDirect(url: string, videoId: string, outPath: string): Promise<boolean> {
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-ytd";
  console.log(`[download] trying youtube for ${videoId}`);
  
  for (const client of ["ios", "android", "mweb"] as const) {
    const args = [
      "--no-warnings",
      "--no-playlist",
      "--no-progress",
      "--socket-timeout", "15",
      "--retries", "2",
      "--fragment-retries", "2",
      "--concurrent-fragments", "5",
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4",
      "-f", "bestaudio[abr<=128]/bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "5",
      "-o", path.join(outDir, `${prefix}.%(ext)s`),
      url,
    ];
    try {
      console.log(`[download] yt-dlp with ${client}…`);
      await runCmd("yt-dlp", args);
      if (await findAndMoveMp3(outDir, prefix, outPath)) {
        console.log(`[download] success with ${client}`);
        return true;
      }
    } catch (e) {
      console.warn(`[download] ${client} failed: ${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
    }
  }
  return false;
}

async function trySoundCloud(title: string, artist: string, outPath: string): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const q = `${title} ${artist}`.trim();
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-sc";
  console.log(`[download] trying soundcloud for ${q}`);
  
  try {
    const { stdout } = await runCmd("yt-dlp", ["--no-warnings", "--flat-playlist", "--print", "%(webpage_url)s", `scsearch1:${q}`]);
    const line = stdout.trim().split("\n")[0] ?? "";
    if (!line.startsWith("https://soundcloud.com/")) {
      console.warn(`[download] no soundcloud result for ${q}`);
      return null;
    }
    console.log(`[download] soundcloud url: ${line}`);
    await runCmd("yt-dlp", ["--no-warnings", "--no-progress", "--socket-timeout", "30", "--concurrent-fragments", "5", "-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", path.join(outDir, `${prefix}.%(ext)s`), line]);
    if (await findAndMoveMp3(outDir, prefix, outPath)) {
      console.log(`[download] soundcloud success`);
      return { title, artist, durationSec: 0 };
    }
  } catch (e) {
    console.warn(`[download] soundcloud failed: ${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`);
    return null;
  }
  return null;
}

export async function debugSources(): Promise<string> {
  try {
    await runCmd("yt-dlp", ["--version"]);
    await runCmd("ffmpeg", ["-version"]);
    return "yt-dlp: ✓\nffmpeg: ✓";
  } catch (e) {
    return `error: ${e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100)}`;
  }
}

export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
  videoId = "",
): Promise<DownloadedAudio> {
  console.log(`[download] start videoId=${videoId} url=${url}`);
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);
  const directUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  
  if (videoId && (await tryYouTubeDirect(directUrl, videoId, finalPath))) {
    return { filePath: finalPath, webUrl: url, title: titleHint || "Track", artist: artistHint || "YouTube", durationSec: 0 };
  }
  
  console.log(`[download] youtube failed, trying soundcloud…`);
  const sc = await trySoundCloud(titleHint, artistHint, finalPath);
  if (sc) {
    return { filePath: finalPath, webUrl: url, ...sc };
  }
  
  console.log(`[download] soundcloud failed, trying youtube fallback…`);
  const fallback = !videoId && (await tryYouTubeDirect(url, "", finalPath));
  if (fallback) {
    return { filePath: finalPath, webUrl: url, title: titleHint || "Track", artist: artistHint || "YouTube", durationSec: 0 };
  }
  
  throw new Error("All download sources failed");
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { }
}
