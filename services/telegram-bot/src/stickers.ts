import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import sharp from "sharp";

const TMP_DIR = path.join(os.tmpdir(), "arya-stickers");

async function ensureTmp(): Promise<void> {
  await fs.mkdir(TMP_DIR, { recursive: true });
}

export function makeShortName(
  rawName: string,
  botUsername: string,
  withRandom = false,
): string {
  const cleaned = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24) || "pack";
  // Telegram requires short_name to end with `_by_<botusername>` and be unique globally.
  // Total length <= 64 chars, ASCII letters/digits/underscores only.
  const tail = `_by_${botUsername}`;
  const base = withRandom
    ? `${cleaned}_${Math.random().toString(36).slice(2, 5)}`
    : cleaned;
  const maxBase = 60 - tail.length;
  return `${base.slice(0, maxBase)}${tail}`;
}

export function packLink(shortName: string): string {
  return `https://t.me/addstickers/${shortName}`;
}

async function tmpFile(ext: string): Promise<string> {
  await ensureTmp();
  return path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

/**
 * Convert any image (PNG/JPEG/WebP) into a Telegram-ready static sticker:
 * - WebP format
 * - One side exactly 512px, the other <=512px
 * - Trims transparent padding so stickers sit edge-to-edge with no gaps
 * - Preserves aspect ratio, no cropping of real content
 */
export async function imageToStickerWebp(input: Buffer): Promise<Buffer> {
  // Read original (auto-orient via EXIF rotate).
  const probe = sharp(input, { failOn: "none" }).rotate();
  const baseMeta = await probe.metadata();
  const hasAlpha = !!baseMeta.hasAlpha;

  // Only attempt to trim transparent borders if the image actually has an alpha
  // channel — trimming a solid-color photo can chop real content.
  let img = sharp(input, { failOn: "none" }).rotate();
  if (hasAlpha) {
    try {
      img = img.trim({
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        threshold: 5,
      });
    } catch {
      // some images can't be trimmed; fall back to original.
      img = sharp(input, { failOn: "none" }).rotate();
    }
  }

  const meta = await img.metadata();
  const w = meta.width || 512;
  const h = meta.height || 512;

  // Telegram requirement: at least one side must equal 512.
  let targetW: number;
  let targetH: number;
  if (w >= h) {
    targetW = 512;
    targetH = Math.max(1, Math.round((h / w) * 512));
  } else {
    targetH = 512;
    targetW = Math.max(1, Math.round((w / h) * 512));
  }

  return await img
    .resize(targetW, targetH, {
      fit: "fill",
      kernel: "lanczos3",
      withoutEnlargement: false,
    })
    // Gentle sharpen to compensate for lanczos softness; keeps detail crisp.
    .sharpen({ sigma: 0.6, m1: 0.5, m2: 1.5 })
    .webp({ quality: 100, lossless: false, effort: 6, smartSubsample: true })
    .toBuffer();
}

/**
 * Convert any video / GIF / animation into a Telegram video-sticker WEBM:
 * - VP9 codec
 * - 512x? or ?x512 (one side exactly 512), aspect preserved
 * - <= 3 seconds, <= 30 fps
 * - <= 256 KB target
 */
export async function videoToStickerWebm(inputPath: string): Promise<Buffer> {
  const outPath = await tmpFile("webm");
  // scale: longer side = 512; pad nothing — Telegram requires one side exactly 512.
  const vf = "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)':flags=lanczos,fps=30";

  await new Promise<void>((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-t",
        "2.95",
        "-i",
        inputPath,
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-vf",
        vf,
        "-b:v",
        "256k",
        "-crf",
        "32",
        "-deadline",
        "good",
        "-cpu-used",
        "4",
        "-auto-alt-ref",
        "0",
        outPath,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with ${code}`));
    });
  });

  const buf = await fs.readFile(outPath);
  fs.unlink(outPath).catch(() => undefined);
  return buf;
}

export async function writeTempFromBuffer(buf: Buffer, ext: string): Promise<string> {
  const p = await tmpFile(ext);
  await fs.writeFile(p, buf);
  return p;
}

export async function cleanupFile(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* ignore */
  }
}

export const STATIC_PACK_LIMIT = 120;
export const VIDEO_PACK_LIMIT = 50;
