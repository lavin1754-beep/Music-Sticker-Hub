import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { YouTube } from "youtube-sr";
import type { SearchResult } from "./state.js";

const TMP_DIR = path.join(os.tmpdir(), "arya-music");

async function ensureTmp(): Promise<void> {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

function cleanQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

// ─── Search cache (avoids re-hitting YouTube for the same query) ──────────────
interface CacheEntry {
  results: SearchResult[];
  expiresAt: number;
}
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCached(key: string): SearchResult[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

function setCache(key: string, results: SearchResult[]): void {
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  // Keep cache from growing unbounded
  if (searchCache.size > 200) {
    const oldest = searchCache.keys().next().value;
    if (oldest) searchCache.delete(oldest);
  }
}

export async function searchMusic(
  query: string,
  kind: "song" | "artist" | "movie" | "lyrics",
  limit = 30,
): Promise<SearchResult[]> {
  let q = cleanQuery(query);
  if (!q) return [];

  switch (kind) {
    case "song":
      q = `${q} audio`;
      break;
    case "artist":
      q = `${q} top songs`;
      break;
    case "movie":
      q = `${q} movie songs jukebox`;
      break;
    case "lyrics":
      break;
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

interface YtDlpJson {
  title?: string;
  uploader?: string;
  artist?: string;
  creator?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  track?: string;
}

// Try iOS first (bypasses cloud IP blocks), fall back to android then web.
const PLAYER_CLIENTS = ["ios", "android", "web"] as const;

function runYtDlpJson(url: string, client: string): Promise<YtDlpJson> {
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--extractor-args",
      `youtube:player_client=${client}`,
      "--force-ipv4",
      "--socket-timeout",
      "15",
      "--retries",
      "1",
      url,
    ];
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp info (${client}) failed (${code}): ${stderr.trim().slice(0, 200)}`));
      }
      try {
        resolve(JSON.parse(stdout) as YtDlpJson);
      } catch (e) {
        reject(new Error(`yt-dlp json parse failed: ${(e as Error).message}`));
      }
    });
  });
}

function runYtDlpDownload(url: string, outPath: string, client: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-warnings",
      "--no-playlist",
      "--no-progress",
      "--extractor-args",
      `youtube:player_client=${client}`,
      "--force-ipv4",
      "--socket-timeout",
      "20",
      "--retries",
      "1",
      "--fragment-retries",
      "1",
      // 128k is indistinguishable from higher for Telegram voice playback
      // and downloads ~2-3x faster than "best"
      "-f",
      "bestaudio[abr<=128]/bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "5",
      "-o",
      outPath,
      url,
    ];
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdout.on("data", () => undefined);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp download (${client}) failed (${code}): ${stderr.trim().slice(0, 200)}`));
    });
  });
}

async function tryDownload(url: string, outTemplate: string): Promise<YtDlpJson> {
  let lastErr: Error | undefined;
  for (const client of PLAYER_CLIENTS) {
    try {
      // Run info fetch and download in parallel for speed; both use same client.
      const [info] = await Promise.all([
        runYtDlpJson(url, client),
        runYtDlpDownload(url, outTemplate, client),
      ]);
      return info;
    } catch (err) {
      lastErr = err as Error;
      console.error(`[music] client=${client} failed: ${lastErr.message}`);
    }
  }
  throw lastErr ?? new Error("all player clients failed");
}

export async function downloadAsMp3(url: string): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  const info = await tryDownload(url, outTemplate);

  try {
    await fs.access(finalPath);
  } catch {
    throw new Error("download completed but mp3 not found");
  }

  const title = info.track || info.title || "Unknown";
  const artist =
    info.artist || info.creator || info.uploader || info.channel || "Unknown";
  const durationSec = Math.round(info.duration || 0);

  return {
    filePath: finalPath,
    title,
    artist,
    durationSec,
    thumbUrl: info.thumbnail,
    webUrl: info.webpage_url || url,
  };
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    /* ignore */
  }
}
