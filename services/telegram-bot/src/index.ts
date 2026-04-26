import { Bot, InputFile, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadStore,
  getState,
  setState,
  pushHistory,
  popHistory,
  resetState,
  getUserPacks,
  addPack,
  setCurrentPack,
  incrementPackCount,
  findPack,
  type SearchResult,
  type Mode,
} from "./state.js";
import {
  WELCOME_MESSAGE,
  homeMenu,
  musicOptionsMenu,
  resultsMenu,
  packFullMenu,
  stickersStartMenu,
} from "./menus.js";
import {
  searchMusic,
  downloadAsMp3,
  cleanupTempFile,
} from "./music.js";
import {
  imageToStickerWebp,
  videoToStickerWebm,
  writeTempFromBuffer,
  cleanupFile,
  makeShortName,
  packLink,
  STATIC_PACK_LIMIT,
  VIDEO_PACK_LIMIT,
} from "./stickers.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("[bot] missing TELEGRAM_BOT_TOKEN env var");
  process.exit(1);
}

// Audio recognition disabled — no ACRCloud / AudD key configured.
// Per spec Fix 3: hide the Voice/Video option when this flag is false.
const AUDIO_RECOGNITION_ENABLED = false;

const RESULTS_PER_PAGE = 10;

const bot = new Bot(TOKEN);

let botUsername = "";

// ----------- shared helpers -----------

async function safeDeleteMessage(ctx: Context, messageId?: number): Promise<void> {
  if (!messageId || !ctx.chat) return;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, messageId);
  } catch {
    /* ignore */
  }
}

async function showHome(ctx: Context, userId: number): Promise<void> {
  resetState(userId);
  const msg = await ctx.reply(WELCOME_MESSAGE, {
    parse_mode: "Markdown",
    reply_markup: homeMenu(AUDIO_RECOGNITION_ENABLED),
  });
  setState(userId, { lastMenuMessageId: msg.message_id });
}

async function showMusicMenu(ctx: Context, userId: number): Promise<void> {
  pushHistory(userId);
  setState(userId, { mode: "music", step: "menu", data: {} });
  const text = "🎵 *Music Library*\n\nHow would you like to find your song?";
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: musicOptionsMenu(AUDIO_RECOGNITION_ENABLED),
      });
      return;
    } catch {
      /* fallthrough */
    }
  }
  const msg = await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: musicOptionsMenu(AUDIO_RECOGNITION_ENABLED),
  });
  setState(userId, { lastMenuMessageId: msg.message_id });
}

async function showStickersMenu(ctx: Context, userId: number): Promise<void> {
  pushHistory(userId);
  setState(userId, { mode: "sticker", step: "menu", data: {} });
  const text =
    "🧩 *Sticker Studio*\n\nTurn anything into a high-quality sticker pack.\nPick an option to begin:";
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: stickersStartMenu(),
      });
      return;
    } catch {
      /* fallthrough */
    }
  }
  const msg = await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: stickersStartMenu(),
  });
  setState(userId, { lastMenuMessageId: msg.message_id });
}

function promptForKind(kind: "song" | "artist" | "movie" | "lyrics"): string {
  switch (kind) {
    case "song":
      return "🎶 *Send the song name*\n\nType the title you're looking for.";
    case "artist":
      return "🎤 *Send the artist name*\n\nI'll fetch their top tracks.";
    case "movie":
      return "🎬 *Send the movie name*\n\nI'll list its songs for you.";
    case "lyrics":
      return "✍️ *Send a line of lyrics*\n\nSpelling doesn't have to be perfect — I'll figure it out.";
  }
}

function formatResults(results: SearchResult[], startIdx: number): string {
  const lines = results.map((r, i) => {
    const num = startIdx + i + 1;
    const safeTitle = r.title.length > 64 ? r.title.slice(0, 61) + "..." : r.title;
    return `*${num}.* ${escapeMd(safeTitle)}\n   _${escapeMd(r.channel)} • ${escapeMd(r.durationFormatted)}_`;
  });
  return `🎧 *Top results*\n\n${lines.join("\n\n")}\n\n_Tap a number to play._`;
}

function escapeMd(s: string): string {
  return s.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

// Strip the markdown helper since we use plain Markdown (not MarkdownV2). Keep simple escaper:
function softEscape(s: string): string {
  return s.replace(/[_*`[\]]/g, (c) => `\\${c}`);
}

// ----------- /start -----------

bot.command("start", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  await showHome(ctx, uid);
});

bot.command("back", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const prev = popHistory(uid);
  if (!prev) {
    await showHome(ctx, uid);
    return;
  }
  if (prev.mode === "music") await showMusicMenu(ctx, uid);
  else if (prev.mode === "sticker") await showStickersMenu(ctx, uid);
  else await showHome(ctx, uid);
});

bot.command("viewpacks", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const u = getUserPacks(uid);
  if (u.packs.length === 0) {
    await ctx.reply("📦 You don't have any sticker packs yet.\nUse 🧩 *Stickers* to create one!", {
      parse_mode: "Markdown",
    });
    return;
  }
  const lines = u.packs.map(
    (p, i) =>
      `*${i + 1}.* ${softEscape(p.name)}  _( ${p.count} stickers )_\n   ${p.link}`,
  );
  await ctx.reply(`📚 *Your Sticker Packs*\n\n${lines.join("\n\n")}`, {
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
  });
});

// ----------- callback queries -----------

bot.callbackQuery("mode:music", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  await showMusicMenu(ctx, uid);
});

bot.callbackQuery("mode:sticker", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  await showStickersMenu(ctx, uid);
});

bot.callbackQuery("back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const prev = popHistory(uid);
  if (!prev || prev.mode === null) {
    await safeDeleteMessage(ctx, ctx.callbackQuery.message?.message_id);
    await showHome(ctx, uid);
    return;
  }
  if (prev.mode === "music") await showMusicMenu(ctx, uid);
  else if (prev.mode === "sticker") await showStickersMenu(ctx, uid);
  else await showHome(ctx, uid);
});

// music option selection
bot.callbackQuery(/^music:opt:(song|artist|movie|lyrics|audio)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const kind = ctx.match[1] as "song" | "artist" | "movie" | "lyrics" | "audio";

  if (kind === "audio") {
    if (!AUDIO_RECOGNITION_ENABLED) {
      await ctx.reply("🎙 Audio recognition isn't available right now.");
      return;
    }
    pushHistory(uid);
    setState(uid, { mode: "music", step: "await_audio" });
    await ctx.reply("🎙 Send me a *voice note* or short *video* and I'll find the song.", {
      parse_mode: "Markdown",
    });
    return;
  }

  pushHistory(uid);
  setState(uid, {
    mode: "music",
    step: "await_query",
    searchKind: kind,
  });
  await ctx.reply(promptForKind(kind), { parse_mode: "Markdown" });
});

bot.callbackQuery("music:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  await showMusicMenu(ctx, uid);
});

bot.callbackQuery("music:next", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const s = getState(uid);
  const all = s.searchResults || [];
  const page = (s.searchPage ?? 0) + 1;
  const start = page * RESULTS_PER_PAGE;
  if (start >= all.length) {
    await ctx.answerCallbackQuery({ text: "No more results", show_alert: false });
    return;
  }
  setState(uid, { searchPage: page });
  await renderResultsPage(ctx, uid);
});

bot.callbackQuery("music:prev", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const s = getState(uid);
  const page = Math.max(0, (s.searchPage ?? 0) - 1);
  setState(uid, { searchPage: page });
  await renderResultsPage(ctx, uid);
});

bot.callbackQuery(/^music:pick:(\d+)$/, async (ctx) => {
  const idxOnPage = parseInt(ctx.match[1], 10);
  const uid = ctx.from.id;
  const s = getState(uid);
  const all = s.searchResults || [];
  const page = s.searchPage ?? 0;
  const start = page * RESULTS_PER_PAGE;
  const pick = all[start + idxOnPage];
  if (!pick) {
    await ctx.answerCallbackQuery({ text: "Result expired, search again", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "🎧 Fetching audio…" });
  await deliverAudio(ctx, pick);
});

// stickers
bot.callbackQuery("stickers:newpack", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  pushHistory(uid);
  setState(uid, { mode: "sticker", step: "await_pack_name" });
  await ctx.reply("✨ *Send your sticker pack name*\n\nGive it a name you'll remember.", {
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("stickers:viewpacks", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const u = getUserPacks(uid);
  if (u.packs.length === 0) {
    await ctx.reply("📦 No packs yet — tap *Create Pack* to start one.", { parse_mode: "Markdown" });
    return;
  }
  const lines = u.packs.map(
    (p, i) => `*${i + 1}.* ${softEscape(p.name)}  _( ${p.count} stickers )_\n   ${p.link}`,
  );
  await ctx.reply(`📚 *Your Sticker Packs*\n\n${lines.join("\n\n")}`, {
    parse_mode: "Markdown",
    link_preview_options: { is_disabled: true },
  });
});

// ----------- text router -----------

bot.on("message:text", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return; // commands handled elsewhere

  const s = getState(uid);

  if (s.mode === "music") {
    if (s.step === "await_query" && s.searchKind) {
      await handleMusicQuery(ctx, text, s.searchKind);
      return;
    }
    await ctx.reply("Please pick an option from the menu first 🎵");
    return;
  }

  if (s.mode === "sticker") {
    if (s.step === "await_pack_name") {
      await handlePackName(ctx, text);
      return;
    }
    if (s.step === "await_media") {
      await ctx.reply("Send images, videos, or GIFs to add to your pack 🎨");
      return;
    }
    await ctx.reply("Pick an option from the menu first 🧩");
    return;
  }

  // No mode — quietly nudge.
  await ctx.reply("Tap /start to open the menu 👋");
});

// ----------- music: text query -> search -----------

async function handleMusicQuery(
  ctx: Context,
  query: string,
  kind: "song" | "artist" | "movie" | "lyrics",
): Promise<void> {
  if (!ctx.from) return;
  const uid = ctx.from.id;
  const wait = await ctx.reply("🔎 Searching…");

  const limit = kind === "lyrics" ? 5 : 30;
  const results = await searchMusic(query, kind, limit);
  await safeDeleteMessage(ctx, wait.message_id);

  if (results.length === 0) {
    await ctx.reply("I couldn't find that 😕 Please check the name and try again.");
    return;
  }

  // Lyrics mode: deliver top match directly when confidence is high (single strong result).
  if (kind === "lyrics") {
    await ctx.reply(`🎯 Best match for those lyrics:`);
    await deliverAudio(ctx, results[0]);
    return;
  }

  setState(uid, {
    mode: "music",
    step: "results",
    searchResults: results,
    searchPage: 0,
    searchQuery: query,
    searchKind: kind,
  });
  await renderResultsPage(ctx, uid);
}

async function renderResultsPage(ctx: Context, uid: number): Promise<void> {
  const s = getState(uid);
  const all = s.searchResults || [];
  const page = s.searchPage ?? 0;
  const start = page * RESULTS_PER_PAGE;
  const pageItems = all.slice(start, start + RESULTS_PER_PAGE);
  if (pageItems.length === 0) {
    await ctx.reply("No more results.");
    return;
  }
  const text = formatResults(pageItems, start);
  const hasMore = start + RESULTS_PER_PAGE < all.length;
  const hasPrev = page > 0;

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: resultsMenu(pageItems, start, hasMore, hasPrev),
      });
      return;
    } catch {
      /* fallthrough */
    }
  }
  await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: resultsMenu(pageItems, start, hasMore, hasPrev),
  });
}

// ----------- music: deliver audio -----------

async function deliverAudio(ctx: Context, pick: SearchResult): Promise<void> {
  const status = await ctx.reply("⬇️ Fetching audio… this takes ~5s");
  let downloaded;
  try {
    downloaded = await downloadAsMp3(pick.url);
  } catch (err) {
    console.error("[deliver] download failed", err);
    await safeDeleteMessage(ctx, status.message_id);
    await ctx.reply(
      "😕 I couldn't fetch that one. Try another result or a different search.",
    );
    return;
  }

  await safeDeleteMessage(ctx, status.message_id);
  try {
    await ctx.replyWithAudio(new InputFile(downloaded.filePath), {
      title: downloaded.title,
      performer: downloaded.artist,
      duration: downloaded.durationSec || undefined,
      caption: `🎵 *${softEscape(downloaded.title)}*\n👤 ${softEscape(downloaded.artist)}`,
      parse_mode: "Markdown",
    });
  } catch (err) {
    console.error("[deliver] send failed", err);
    await ctx.reply("😕 Couldn't send the audio. Please try another result.");
  } finally {
    cleanupTempFile(downloaded.filePath);
  }
}

// ----------- sticker: pack name -> create pack lazily -----------

async function handlePackName(ctx: Context, name: string): Promise<void> {
  if (!ctx.from) return;
  const uid = ctx.from.id;
  const trimmed = name.trim().slice(0, 60);
  if (!trimmed) {
    await ctx.reply("Please send a non-empty name 🙂");
    return;
  }

  setState(uid, {
    mode: "sticker",
    step: "await_media",
    pendingPackName: trimmed,
    currentPackShortName: undefined,
  });
  await ctx.reply(
    `✅ Pack ready: *${softEscape(trimmed)}*\n\nNow send images, videos, or GIFs to convert into stickers 🎨\n_You can send many — I'll add them as fast as possible._`,
    { parse_mode: "Markdown" },
  );
}

// ----------- sticker: media handlers -----------

async function downloadFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  const fpath = file.file_path;
  if (!fpath) throw new Error("missing file_path");
  const url = `https://api.telegram.org/file/bot${TOKEN}/${fpath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function ensureStaticPack(ctx: Context, uid: number): Promise<string | null> {
  const s = getState(uid);
  // If we already have a current static pack with room, reuse it.
  if (s.currentPackShortName) {
    const existing = findPack(uid, s.currentPackShortName);
    if (existing && existing.kind === "static" && existing.count < STATIC_PACK_LIMIT) {
      return existing.shortName;
    }
  }
  // Need to create a new pack — but only after we have the FIRST sticker.
  return null;
}

bot.on(["message:photo", "message:document"], async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const s = getState(uid);
  if (s.mode !== "sticker" || s.step !== "await_media") {
    if (s.mode === "music") {
      await ctx.reply("🎵 You're in *Music* mode. Pick a search option first.", {
        parse_mode: "Markdown",
      });
      return;
    }
    return;
  }
  if (!s.pendingPackName) {
    await ctx.reply("Send your pack name first 🙂");
    return;
  }

  // Determine if photo or document and which kind.
  let fileId: string | null = null;
  let isVideo = false;
  let isAnimation = false;

  if (ctx.message?.photo && ctx.message.photo.length > 0) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  } else if (ctx.message?.document) {
    const mime = ctx.message.document.mime_type || "";
    fileId = ctx.message.document.file_id;
    if (mime.startsWith("video/") || mime === "image/gif") {
      isVideo = true;
      isAnimation = mime === "image/gif";
    } else if (!mime.startsWith("image/")) {
      await ctx.reply("Unsupported file type 🥲 Send an image, video, or GIF.");
      return;
    }
  }
  if (!fileId) return;

  if (isVideo || isAnimation) {
    await processVideoSticker(ctx, uid, fileId, s.pendingPackName);
  } else {
    await processStaticSticker(ctx, uid, fileId, s.pendingPackName);
  }
});

bot.on(["message:video", "message:animation", "message:video_note"], async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const s = getState(uid);
  if (s.mode !== "sticker" || s.step !== "await_media") {
    if (s.mode === "music") {
      await ctx.reply("🎵 You're in *Music* mode. Pick a search option first.", {
        parse_mode: "Markdown",
      });
      return;
    }
    return;
  }
  if (!s.pendingPackName) {
    await ctx.reply("Send your pack name first 🙂");
    return;
  }

  const fileId =
    ctx.message?.video?.file_id ??
    ctx.message?.animation?.file_id ??
    ctx.message?.video_note?.file_id;
  if (!fileId) return;
  await processVideoSticker(ctx, uid, fileId, s.pendingPackName);
});

async function processStaticSticker(
  ctx: Context,
  uid: number,
  fileId: string,
  pendingName: string,
): Promise<void> {
  try {
    const buf = await downloadFile(ctx, fileId);
    const webp = await imageToStickerWebp(buf);

    const shortName = await ensureOrCreateStaticPack(ctx, uid, pendingName, webp);
    if (!shortName) return;

    // If the pack already exists, add to it.
    const pack = findPack(uid, shortName);
    if (pack && pack.count > 0) {
      // Pack exists & has stickers → add another.
      try {
        const tmp = await writeTempFromBuffer(webp, "webp");
        await ctx.api.addStickerToSet(uid, shortName, {
          sticker: new InputFile(tmp),
          format: "static",
          emoji_list: ["✨"],
        });
        await cleanupFile(tmp);
        incrementPackCount(uid, shortName);
      } catch (err) {
        await handleStickerError(ctx, uid, err, "static");
        return;
      }
    }

    await replyWithStickerLink(ctx, uid, shortName);
  } catch (err) {
    console.error("[sticker static] failed", err);
    await ctx.reply("😕 Couldn't convert that one. Try another file.");
  }
}

async function processVideoSticker(
  ctx: Context,
  uid: number,
  fileId: string,
  pendingName: string,
): Promise<void> {
  let inputPath: string | null = null;
  try {
    const buf = await downloadFile(ctx, fileId);
    inputPath = path.join(os.tmpdir(), `sin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
    await fs.writeFile(inputPath, buf);
    const webm = await videoToStickerWebm(inputPath);

    const shortName = await ensureOrCreateVideoPack(ctx, uid, pendingName, webm);
    if (!shortName) return;

    const pack = findPack(uid, shortName);
    if (pack && pack.count > 0) {
      try {
        const tmp = await writeTempFromBuffer(webm, "webm");
        await ctx.api.addStickerToSet(uid, shortName, {
          sticker: new InputFile(tmp),
          format: "video",
          emoji_list: ["🎬"],
        });
        await cleanupFile(tmp);
        incrementPackCount(uid, shortName);
      } catch (err) {
        await handleStickerError(ctx, uid, err, "video");
        return;
      }
    }

    await replyWithStickerLink(ctx, uid, shortName);
  } catch (err) {
    console.error("[sticker video] failed", err);
    await ctx.reply("😕 Couldn't convert that video. Try another file.");
  } finally {
    if (inputPath) await cleanupFile(inputPath);
  }
}

async function ensureOrCreateStaticPack(
  ctx: Context,
  uid: number,
  pendingName: string,
  firstSticker: Buffer,
): Promise<string | null> {
  // Reuse current static pack if it has room.
  const existing = await ensureStaticPack(ctx, uid);
  if (existing) return existing;

  const shortName = makeShortName(pendingName, botUsername);
  const tmp = await writeTempFromBuffer(firstSticker, "webp");

  try {
    await ctx.api.createNewStickerSet(uid, shortName, pendingName, [
      {
        sticker: new InputFile(tmp),
        format: "static",
        emoji_list: ["✨"],
      },
    ]);
  } catch (err) {
    await cleanupFile(tmp);
    console.error("[pack create static] failed", err);
    if (err instanceof GrammyError && err.description.includes("STICKERSET_INVALID")) {
      await ctx.reply("Try a different pack name — that one is taken.");
    } else {
      await ctx.reply(`😕 Couldn't create the pack: ${err instanceof Error ? err.message : "unknown"}`);
    }
    return null;
  }
  await cleanupFile(tmp);

  addPack(uid, {
    name: pendingName,
    shortName,
    link: packLink(shortName),
    kind: "static",
    count: 1,
    createdAt: Date.now(),
  });
  setCurrentPack(uid, shortName);
  return shortName;
}

async function ensureOrCreateVideoPack(
  ctx: Context,
  uid: number,
  pendingName: string,
  firstSticker: Buffer,
): Promise<string | null> {
  const s = getState(uid);
  if (s.currentPackShortName) {
    const existing = findPack(uid, s.currentPackShortName);
    if (existing && existing.kind === "video" && existing.count < VIDEO_PACK_LIMIT) {
      return existing.shortName;
    }
  }
  const shortName = makeShortName(`${pendingName}_video`, botUsername);
  const tmp = await writeTempFromBuffer(firstSticker, "webm");
  try {
    await ctx.api.createNewStickerSet(uid, shortName, `${pendingName} (Video)`, [
      {
        sticker: new InputFile(tmp),
        format: "video",
        emoji_list: ["🎬"],
      },
    ]);
  } catch (err) {
    await cleanupFile(tmp);
    console.error("[pack create video] failed", err);
    await ctx.reply(`😕 Couldn't create the video pack: ${err instanceof Error ? err.message : "unknown"}`);
    return null;
  }
  await cleanupFile(tmp);

  addPack(uid, {
    name: `${pendingName} (Video)`,
    shortName,
    link: packLink(shortName),
    kind: "video",
    count: 1,
    createdAt: Date.now(),
  });
  setCurrentPack(uid, shortName);
  return shortName;
}

async function handleStickerError(
  ctx: Context,
  uid: number,
  err: unknown,
  kind: "static" | "video",
): Promise<void> {
  console.error(`[sticker add ${kind}] failed`, err);
  if (err instanceof GrammyError) {
    if (
      err.description.includes("STICKERS_TOO_MUCH") ||
      err.description.includes("PACK_FULL") ||
      err.description.includes("STICKERSET_INVALID")
    ) {
      await ctx.reply("Your pack is full 📦 Create a new one?", {
        reply_markup: packFullMenu(),
      });
      setCurrentPack(uid, undefined);
      return;
    }
  }
  await ctx.reply(`😕 Couldn't add to the pack: ${err instanceof Error ? err.message : "unknown"}`);
}

async function replyWithStickerLink(ctx: Context, uid: number, shortName: string): Promise<void> {
  const pack = findPack(uid, shortName);
  if (!pack) return;
  await ctx.reply(
    `✅ Added to *${softEscape(pack.name)}*  ( ${pack.count} stickers )\n${pack.link}\n\nKeep sending media to add more!`,
    { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
  );
}

// ----------- error handler -----------

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error("[grammy]", e.description);
  else if (e instanceof HttpError) console.error("[http]", e);
  else console.error("[bot]", e);
});

// ----------- bootstrap -----------

async function main(): Promise<void> {
  await loadStore();
  const me = await bot.api.getMe();
  botUsername = me.username;
  console.log(`[bot] starting as @${botUsername}`);
  // Drop pending updates from previous runs to avoid stale state.
  await bot.start({
    drop_pending_updates: true,
    onStart: () => console.log("[bot] polling started"),
  });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[bot] shutting down…");
  try {
    await bot.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

main().catch((err) => {
  console.error("[bot] fatal", err);
  process.exit(1);
});
