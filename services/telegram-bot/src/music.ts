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

async function searchViaPiped(q: string, limit: number): Promise<SearchResult[]> {
  const url = `https://piped.video/api/v1/search?q=${encodeURIComponent(q)}&type=video`;
  const resp = await fetch(url, { headers: { Accept: "application/json" } });
  if (!resp.ok) return [];
  const json = await resp.json() as any;
  const data = json.results || (Array.isArray(json) ? json : []);
  
  return data.slice(0, limit).flatMap((v: any) => {
    let id = "";
    if (v.url) {
      const m = v.url.match(/v=([\w-]{6,32})/);
      if (m) id = m[1];
      else {
        const m2 = v.url.match(/\/watch\/([\w-]{6,32})/);
        if (m2) id = m2[1];
      }
    }
    if (v.id && !id) id = v.id;
    
    if (!id || !v.title) return [];
    return [{
      videoId: id,
      title: v.title,
      url: `https://www.youtube.com/watch?v=${id}`,
      channel: v.uploaderName || "Unknown",
      durationFormatted: v.duration ? new Date(v.duration * 1000).toISOString().slice(14, 19) : "?",
    }];
  });
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
    const results = await searchViaPiped(q, limit);
    if (results.length > 0) {
      setCache(key, results);
      return results;
    }
    console.warn(`[music search] piped returned 0 results for: ${q}`);
    return [];
  } catch (err) {
    console.error("[music search] failed:", err instanceof Error ? err.message : String(err));
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

async function tryYouTubeDirect(url: string, outPath: string): Promise<boolean> {
  const outDir = path.dirname(outPath);
  const prefix = path.basename(outPath, ".mp3") + "-ytd";
  console.log(`[download] trying youtube direct for ${url}`);
  
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
    try {
      console.log(`[download] yt-dlp with ${client} client…`);
      await runCmd("yt-dlp", args);
      if (await findAndMoveMp3(outDir, prefix, outPath)) {
        console.log(`[download] success with ${client}`);
        return true;
      }
    } catch (e) {
      console.warn(`[download] ${client} failed: ${e instanceof Error ? e.message : String(e)}`);
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
    console.log(`[download] found soundcloud: ${line}`);
    await runCmd("yt-dlp", ["--no-warnings", "--no-progress", "--socket-timeout", "30", "--concurrent-fragments", "5", "-x", "--audio-format", "mp3", "--audio-quality", "5", "-o", path.join(outDir, `${prefix}.%(ext)s`), line]);
    if (await findAndMoveMp3(outDir, prefix, outPath)) {
      console.log(`[download] soundcloud success`);
      return { title, artist, durationSec: 0 };
    }
  } catch (e) {
    console.warn(`[download] soundcloud failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  return null;
}

export async function debugSources(): Promise<string> {
  try {
    await runCmd("yt-dlp", ["--version"]);
    await runCmd("ffmpeg", ["-version"]);
    return "yt-dlp: ✓\nffmpeg: ✓\ncookies: n/a";
  } catch (e) {
    return `yt-dlp/ffmpeg: missing\n${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function downloadAsMp3(
  url: string,
  titleHint = "",
  artistHint = "",
  videoId = "",
): Promise<DownloadedAudio> {
  console.log(`[download] starting for videoId=${videoId}, url=${url}`);
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);
  const directUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
  
  if (await tryYouTubeDirect(directUrl, finalPath)) {
    return { filePath: finalPath, webUrl: url, title: titleHint || "Selected track", artist: artistHint || "YouTube", durationSec: 0 };
  }
  console.log(`[download] youtube direct failed, trying soundcloud…`);
  
  const sc = await trySoundCloud(titleHint, artistHint, finalPath);
  if (sc) {
    return { filePath: finalPath, webUrl: url, ...sc };
  }
  console.log(`[download] soundcloud failed, trying fallback…`);
  
  const fallback = videoId ? false : await tryYouTubeDirect(url, finalPath);
  if (fallback) {
    return { filePath: finalPath, webUrl: url, title: titleHint || "Selected track", artist: artistHint || "YouTube", durationSec: 0 };
  }
  
  throw new Error("All music sources failed (YouTube direct, SoundCloud fallback)");
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { }
}
