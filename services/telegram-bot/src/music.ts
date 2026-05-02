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

// ─── Search cache ─────────────────────────────────────────────────────────────
interface CacheEntry { results: SearchResult[]; expiresAt: number }
const searchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

function getCached(key: string): SearchResult[] | null {
  const e = searchCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { searchCache.delete(key); return null; }
  return e.results;
}
function setCache(key: string, results: SearchResult[]): void {
  searchCache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
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
    case "song":    q = `${q} audio`; break;
    case "artist":  q = `${q} top songs`; break;
    case "movie":   q = `${q} movie songs jukebox`; break;
    case "lyrics":  break;
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

// ─── yt-dlp path (primary) ────────────────────────────────────────────────────
// Try multiple player clients — cloud IPs are blocked by YouTube's default
// web client but iOS/Android clients often bypass those restrictions.
const PLAYER_CLIENTS = ["ios", "android", "mweb"] as const;

function ytDlpJson(url: string, client: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [
      "--dump-single-json", "--no-warnings", "--no-playlist",
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4", "--socket-timeout", "12", "--retries", "1", url,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp info (${client}): ${err.slice(0, 150)}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function ytDlpDownload(url: string, out: string, client: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", [
      "--no-warnings", "--no-playlist", "--no-progress",
      "--extractor-args", `youtube:player_client=${client}`,
      "--force-ipv4", "--socket-timeout", "20", "--retries", "1", "--fragment-retries", "1",
      "-f", "bestaudio[abr<=128]/bestaudio/best",
      "--extract-audio", "--audio-format", "mp3", "--audio-quality", "5",
      "-o", out, url,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp dl (${client}): ${err.slice(0, 150)}`));
    });
  });
}

// ─── Piped API fallback (works on all cloud IPs, no auth needed) ──────────────
// Piped is an open-source YouTube frontend — its API returns direct audio
// stream URLs that ffmpeg can download directly, bypassing yt-dlp entirely.
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://piped-api.garudalinux.org",
];

interface PipedStream {
  url: string;
  mimeType?: string;
  bitrate?: number;
  quality?: string;
}
interface PipedResponse {
  title?: string;
  uploader?: string;
  duration?: number;
  thumbnailUrl?: string;
  audioStreams?: PipedStream[];
}

async function getPipedAudio(videoId: string): Promise<{ streamUrl: string; meta: PipedResponse }> {
  const errors: string[] = [];
  for (const base of PIPED_INSTANCES) {
    try {
      const resp = await fetch(`${base}/streams/${videoId}`, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as PipedResponse;
      const streams = (data.audioStreams ?? []).filter((s) => s.url);
      if (!streams.length) throw new Error("no audio streams");
      // Pick the best stream (highest bitrate ≤ 128 kbps, or best available)
      const best = streams
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
        .find((s) => (s.bitrate ?? 999) <= 130000) ?? streams[0];
      return { streamUrl: best.url, meta: data };
    } catch (err) {
      errors.push(`${base}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All Piped instances failed: ${errors.join("; ")}`);
}

function ffmpegDownloadUrl(streamUrl: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", streamUrl,
      "-vn", "-ar", "44100", "-ac", "2", "-b:a", "128k",
      outPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg: ${err.slice(0, 200)}`));
    });
  });
}

// ─── Main download orchestrator ───────────────────────────────────────────────
export async function downloadAsMp3(url: string): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  const videoId = new URL(url).searchParams.get("v") ?? url.split("v=")[1]?.split("&")[0] ?? "";

  // ── Attempt 1: yt-dlp with multiple player clients ──
  for (const client of PLAYER_CLIENTS) {
    try {
      const [info] = await Promise.all([
        ytDlpJson(url, client),
        ytDlpDownload(url, outTemplate, client),
      ]);
      await fs.access(finalPath);
      return {
        filePath: finalPath,
        title: String(info.track || info.title || "Unknown"),
        artist: String(info.artist || info.creator || info.uploader || info.channel || "Unknown"),
        durationSec: Math.round(Number(info.duration) || 0),
        thumbUrl: info.thumbnail as string | undefined,
        webUrl: String(info.webpage_url || url),
      };
    } catch (err) {
      console.error(`[music] yt-dlp client=${client} failed:`, (err as Error).message);
    }
  }

  // ── Attempt 2: Piped API + direct ffmpeg download ──
  console.log("[music] yt-dlp all clients failed, trying Piped API…");
  if (!videoId) throw new Error("cannot extract videoId from URL");
  const { streamUrl, meta } = await getPipedAudio(videoId);
  await ffmpegDownloadUrl(streamUrl, finalPath);
  await fs.access(finalPath);

  return {
    filePath: finalPath,
    title: meta.title || "Unknown",
    artist: meta.uploader || "Unknown",
    durationSec: Math.round(meta.duration || 0),
    thumbUrl: meta.thumbnailUrl,
    webUrl: url,
  };
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try { await fs.unlink(filePath); } catch { /* ignore */ }
}
