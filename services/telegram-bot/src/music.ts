import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import ytdl from "@distube/ytdl-core";
import YouTube from "youtube-sr";
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
      q = `${q} song audio`;
      break;
    case "artist":
      q = `${q} top songs`;
      break;
    case "movie":
      q = `${q} movie songs`;
      break;
    case "lyrics":
      q = `${q} lyrics song`;
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

export async function downloadAsMp3(url: string): Promise<DownloadedAudio> {
  await ensureTmp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outPath = path.join(TMP_DIR, `${id}.mp3`);

  const info = await ytdl.getInfo(url);
  const details = info.videoDetails;
  const title = details.title;
  const artist = details.author?.name || details.media?.artist || "Unknown";
  const durationSec = parseInt(details.lengthSeconds, 10) || 0;
  const thumbUrl =
    details.thumbnails?.sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;

  const audioFormat = ytdl.chooseFormat(info.formats, {
    quality: "highestaudio",
    filter: "audioonly",
  });

  if (!audioFormat) {
    throw new Error("No audio format available");
  }

  await new Promise<void>((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, { format: audioFormat });
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-metadata",
        `title=${title}`,
        "-metadata",
        `artist=${artist}`,
        outPath,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );

    stream.on("error", (e) => {
      reject(e);
    });
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
    stream.pipe(ff.stdin);
  });

  return {
    filePath: outPath,
    title,
    artist,
    durationSec,
    thumbUrl,
    webUrl: url,
  };
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    /* ignore */
  }
}
