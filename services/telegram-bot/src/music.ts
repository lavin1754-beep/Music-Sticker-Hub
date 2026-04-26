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
      // For lyrics search, don't add fluff — match the user's quoted line directly.
      break;
  }

  try {
    const videos = await YouTube.search(q, { type: "video", limit, safeSearch: false });
    return videos
      .filter((v) => v.id && v.title)
      .map((v) => ({
        title: v.title || "Unknown",
        url: `https://www.youtube.com/watch?v=${v.id}`,
        channel: v.channel?.name || "Unknown",
        durationFormatted: v.durationFormatted || "?",
      }));
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

function runYtDlpJson(url: string): Promise<YtDlpJson> {
  return new Promise((resolve, reject) => {
    const args = [
      "--dump-single-json",
      "--no-warnings",
      "--no-playlist",
      "--socket-timeout",
      "20",
      "--retries",
      "3",
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
        return reject(new Error(`yt-dlp info failed (${code}): ${stderr.trim().slice(0, 300)}`));
      }
      try {
        resolve(JSON.parse(stdout) as YtDlpJson);
      } catch (e) {
        reject(new Error(`yt-dlp json parse failed: ${(e as Error).message}`));
      }
    });
  });
}

function runYtDlpDownload(url: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Extract bestaudio, transcode to MP3 192k via ffmpeg (which yt-dlp orchestrates).
    const args = [
      "--no-warnings",
      "--no-playlist",
      "--no-progress",
      "--socket-timeout",
      "30",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "-f",
      "bestaudio/best",
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
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
      else reject(new Error(`yt-dlp download failed (${code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
}

export async function downloadAsMp3(url: string): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // yt-dlp will write to <id>.mp3 because we set audio-format mp3 and -o ends with placeholder.
  const outTemplate = path.join(TMP_DIR, `${id}.%(ext)s`);
  const finalPath = path.join(TMP_DIR, `${id}.mp3`);

  const [info] = await Promise.all([
    runYtDlpJson(url),
    runYtDlpDownload(url, outTemplate),
  ]);

  // Verify the mp3 exists.
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
