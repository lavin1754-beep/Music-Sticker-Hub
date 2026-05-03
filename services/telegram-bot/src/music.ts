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

function runCmd(cmd: string, args: string[], logLabel = ""): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    console.log(`[runCmd] ${cmd}${logLabel ? " " + logLabel : ""}`);
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("error", (e) => {
      console.error(`[runCmd] spawn error: ${e.message}`);
      reject(e);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 200)}`));
      }
    });
  });
}

async function searchViaYtDlp(query: string, limit: number): Promise<SearchResult[]> {
  console.log(`[search] yt-dlp: ${query}`);
  try {
    const args = [
      "--no-warnings",
      "--flat-playlist",
      "--dump-json",
      "--default-search", "ytsearch",
      "-f", "best",
      `ytsearch${limit}:${query}`,
    ];
    const { stdout } = await runCmd("yt-dlp", args, "search");
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
    
    console.log(`[search] got ${results.length} results`);
    return results;
  } catch (err) {
    console.error("[search] failed:", err instanceof Error ? err.message : String(err));
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
  if (cached) return cached;
  
  try {
    const results = await searchViaYtDlp(q, Math.min(limit, 50));
    if (results.length > 0) {
      setCache(key, results);
      return results;
    }
    console.warn(`[search] no results for: ${q}`);
    return [];
  } catch (err) {
    console.error("[search] error:", err instanceof Error ? err.message : String(err));
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
  try {
    const expected = path.join(outDir, `${prefix}.mp3`);
    await fs.access(expected);
    if (expected !== finalPath) await fs.rename(expected, finalPath);
    console.log(`[file] found at ${expected}`);
    return true;
  } catch {
  }
  
  try {
    const files = await fs.readdir(outDir);
    const match = files.find((f) => f.startsWith(prefix) && f.endsWith(".mp3"));
    if (match) {
      const src = path.join(outDir, match);
      await fs.rename(src, finalPath);
      console.log(`[file] found as ${match}`);
      return true;
    }
  } catch {
  }
  
  console.warn(`[file] not found (prefix: ${prefix})`);
  return false;
}

async function downloadWithYtDlp(url: string, outPath: string, prefix: string, quality = 0): Promise<boolean> {
  const outDir = path.dirname(outPath);
  
  const args = [
    "--no-warnings",
    "--no-playlist",
    "--socket-timeout", "30",
    "--retries", "7",
    "--fragment-retries", "5",
    "--concurrent-fragments", "15",
    "-f", "bestaudio",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", String(quality),
    "-o", path.join(outDir, `${prefix}.%(ext)s`),
    url,
  ];
  
  try {
    console.log(`[yt-dlp] downloading quality=${quality}…`);
    await runCmd("yt-dlp", args, `quality=${quality}`);
    console.log(`[yt-dlp] completed quality=${quality}`);
    return await findAndMoveMp3(outDir, prefix, outPath);
  } catch (err) {
    console.error(`[yt-dlp] quality=${quality} failed:`, err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80));
    return false;
  }
}

async function tryYouTubeDirect(url: string, videoId: string, outPath: string): Promise<boolean> {
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-ytd";
  
  console.log(`[download] youtube ${videoId}`);
  
  for (const quality of [0, 2, 4, 5] as const) {
    if (await downloadWithYtDlp(url, outPath, prefix, quality)) {
      console.log(`[download] ✓ youtube success`);
      return true;
    }
  }
  
  console.error(`[download] youtube failed all qualities`);
  return false;
}

async function trySoundCloud(title: string, artist: string, outPath: string): Promise<{ title: string; artist: string; durationSec: number } | null> {
  const q = `${title} ${artist}`.trim();
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-sc";
  
  console.log(`[download] soundcloud: ${q}`);
  
  try {
    const { stdout } = await runCmd("yt-dlp", ["--no-warnings", "--flat-playlist", "--print", "%(webpage_url)s", `scsearch1:${q}`], "soundcloud search");
    const line = stdout.trim().split("\n")[0] ?? "";
    if (!line.startsWith("https://soundcloud.com/")) {
      console.warn(`[download] no soundcloud result`);
      return null;
    }
    
    console.log(`[download] found soundcloud`);
    await runCmd("yt-dlp", ["--no-warnings", "--socket-timeout", "30", "--retries", "5", "-x", "--audio-format", "mp3", "-o", path.join(outDir, `${prefix}.%(ext)s`), line], "soundcloud download");
    
    if (await findAndMoveMp3(outDir, prefix, outPath)) {
      console.log(`[download] ✓ soundcloud success`);
      return { title, artist, durationSec: 0 };
    }
  } catch (err) {
    console.error(`[download] soundcloud error:`, err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80));
  }
  
  return null;
}

async function tryDirect(url: string, outPath: string): Promise<boolean> {
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-direct";
  
  console.log(`[download] direct fallback`);
  
  try {
    await runCmd("yt-dlp", ["--no-warnings", "-x", "--audio-format", "mp3", "-o", path.join(outDir, `${prefix}.%(ext)s`), url], "direct");
    return await findAndMoveMp3(outDir, prefix, outPath);
  } catch (err) {
    console.error(`[download] direct failed:`, err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80));
    return false;
  }
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
  console.log(`[download] START videoId=${videoId}`);
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);
  const directUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  
  if (videoId && (await tryYouTubeDirect(directUrl, videoId, finalPath))) {
    return { filePath: finalPath, webUrl: url, title: titleHint || "Track", artist: artistHint || "YouTube", durationSec: 0 };
  }
  
  console.log(`[download] trying soundcloud…`);
  const sc = await trySoundCloud(titleHint, artistHint, finalPath);
  if (sc) {
    return { filePath: finalPath, webUrl: url, ...sc };
  }
  
  console.log(`[download] trying direct fallback…`);
  if (await tryDirect(url, finalPath)) {
    return { filePath: finalPath, webUrl: url, title: titleHint || "Track", artist: artistHint || "YouTube", durationSec: 0 };
  }
  
  console.log(`[download] FAILED all sources`);
  throw new Error("All download sources failed");
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { }
}
