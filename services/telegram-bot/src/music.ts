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
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 40000 });
    let out = "";
    let err = "";
    
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timeout`));
    }, 40000);
    
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(`${cmd} exited ${code}`));
      }
    });
  });
}

async function searchViaYtDlp(query: string, limit: number): Promise<SearchResult[]> {
  console.log(`[search] query: ${query}`);
  try {
    const { stdout } = await runCmd("yt-dlp", [
      "--no-warnings",
      "--dump-json",
      "--no-playlist",
      "-j",
      `ytsearch${limit}:${query}`,
    ]);
    
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
        // skip malformed JSON
      }
    }
    
    console.log(`[search] found ${results.length} results`);
    return results;
  } catch (err) {
    console.error("[search] error:", err instanceof Error ? err.message : String(err));
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
  }
  
  const key = `${kind}:${q}`;
  const cached = getCached(key);
  if (cached) return cached;
  
  try {
    const results = await searchViaYtDlp(q, Math.min(limit, 50));
    if (results.length > 0) {
      setCache(key, results);
      return results;
    }
    return [];
  } catch (err) {
    console.error("[search] catch error:", err);
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
    await runCmd("yt-dlp", ["--version"]);
    await runCmd("ffmpeg", ["-version"]);
    return "yt-dlp: ✓\nffmpeg: ✓";
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
  videoId = "",
): Promise<DownloadedAudio> {
  console.log(`[download] start: ${videoId || url}`);
  await ensureTmp();
  
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);
  const directUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  
  const args = [
    "--no-warnings",
    "--no-playlist",
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--socket-timeout", "30",
    "--retries", "10",
    "--fragment-retries", "10",
    "--concurrent-fragments", "20",
    "-o", finalPath.replace(/\.mp3$/, ""),
    directUrl,
  ];
  
  console.log(`[download] running yt-dlp for ${videoId}`);
  try {
    await runCmd("yt-dlp", args);
    
    if (await fileExists(finalPath)) {
      console.log(`[download] success`);
      return {
        filePath: finalPath,
        webUrl: url,
        title: titleHint || "Track",
        artist: artistHint || "Artist",
        durationSec: 0,
      };
    }
    
    console.error(`[download] file not created at ${finalPath}`);
    throw new Error("Download completed but file not found");
  } catch (err) {
    console.error(`[download] failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error("Could not fetch audio - try another search result");
  }
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // ignore
  }
}
