import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SearchResult } from "./state.js";

const TMP_DIR = path.join(os.tmpdir(), "arya-music");
const execFileAsync = promisify(execFile);

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
  }
  
  const key = `${kind}:${q}`;
  const cached = getCached(key);
  if (cached) return cached;
  
  console.log(`[search] start: ${q}`);
  
  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--no-warnings",
      "--dump-json",
      "--no-playlist",
      "-j",
      `ytsearch${Math.min(limit, 50)}:${q}`,
    ], { timeout: 25000, maxBuffer: 1024 * 1024 * 10 });
    
    const lines = stdout.trim().split("\n").filter((l) => l);
    const results: SearchResult[] = [];
    
    for (const line of lines.slice(0, limit)) {
      try {
        const item = JSON.parse(line) as any;
        const videoId = item.id || "";
        const title = item.title || "";
        const channel = item.uploader || "";
        const duration = item.duration || 0;
        
        if (!videoId || !title) continue;
        
        results.push({
          videoId,
          title,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          channel,
          durationFormatted: duration > 0 ? formatDuration(duration) : "?",
        });
      } catch {
        // skip
      }
    }
    
    console.log(`[search] found ${results.length}`);
    if (results.length > 0) {
      setCache(key, results);
    }
    return results;
  } catch (err) {
    console.error(`[search] error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export interface DownloadedAudio {
  filePath: string;
  title: string;
  artist: string;
  durationSec: number;
  webUrl: string;
}

export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
  videoId = "",
): Promise<DownloadedAudio> {
  console.log(`[download] start: ${videoId}`);
  await ensureTmp();
  
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);
  const directUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  
  try {
    await execFileAsync("yt-dlp", [
      "--no-warnings",
      "--no-playlist",
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--socket-timeout", "20",
      "--retries", "3",
      "--fragment-retries", "3",
      "--concurrent-fragments", "10",
      "-o", finalPath.replace(/\.mp3$/, ""),
      directUrl,
    ], { timeout: 35000, maxBuffer: 10 * 1024 * 1024 });
    
    const exists = await fileExists(finalPath);
    if (!exists) {
      throw new Error("File not found after download");
    }
    
    console.log(`[download] success`);
    return {
      filePath: finalPath,
      webUrl: url,
      title: titleHint || "Track",
      artist: artistHint || "Artist",
      durationSec: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[download] error: ${msg.slice(0, 100)}`);
    throw new Error("Could not fetch that song. Try another result.");
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function debugSources(): Promise<string> {
  try {
    await execFileAsync("yt-dlp", ["--version"], { timeout: 10000 });
    await execFileAsync("ffmpeg", ["-version"], { timeout: 10000 });
    return "yt-dlp: ✓\nffmpeg: ✓";
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}
