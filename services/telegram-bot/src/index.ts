import { Bot, InputFile, GrammyError, HttpError } from "grammy";
import type { Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
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
  initCookies,
  debugSources,
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

const AUDIO_RECOGNITION_ENABLED = false;
const bot = new Bot(TOKEN);
bot.use(sequentialize((ctx) => ctx.from?.id.toString() ?? ""));
let botUsername = "";

async function safeDeleteMessage(ctx: Context, messageId?: number): Promise<void> {
  if (!messageId || !ctx.chat) return;
  try {
    await ctx.api.deleteMessage(ctx.chat.id, messageId);
  } catch {
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
  setState(userId, { mode: "music", step: "menu", data: {}, selectedVideoId: undefined });
  const text = "🎵 *Music Library*\n\nHow would you like to find your song?";
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: musicOptionsMenu(AUDIO_RECOGNITION_ENABLED),
      });
      return;
    } catch {
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
  const s = getState(userId);
  let currentPackName: string | undefined;
  if (s.currentPackShortName) {
    const pack = findPack(userId, s.currentPackShortName);
    if (pack) {
      const limit = pack.kind === "video" ? VIDEO_PACK_LIMIT : STATIC_PACK_LIMIT;
      if (pack.count < limit) currentPackName = pack.name;
    }
  }
  const text =
    "🧩 *Sticker Studio*\n\nTurn anything into a high-quality sticker pack.\nPick an option to begin:";
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: stickersStartMenu(currentPackName),
      });
      return;
    } catch {
    }
  }
  const msg = await ctx.reply(text, {
    parse_mode: "Markdown",
    reply_markup: stickersStartMenu(currentPackName),
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

function formatResults(results: SearchResult[]): string {
  const lines = results.map((r, i) => {
    const safeTitle = r.title.length > 52 ? r.title.slice(0, 49) + "…" : r.title;
    const dur = r.durationFormatted || "?";
    return `<b>${i + 1}.</b> ${htmlEscape(safeTitle)} <i>[${htmlEscape(dur)}]</i>`;
  });
  return `🎧 <b>Results</b>\n\n${lines.join("\n")}\n\n<i>Tap a number below to download.</i>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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

bot.command("debug", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const wait = await ctx.reply("🔍 Testing all download sources, please wait 20s…");
  try {
    const report = await debugSources();
    await safeDeleteMessage(ctx, wait.message_id);
    await ctx.reply(`<b>Download source status:</b>\n\n<pre>${htmlEscape(report)}</pre>`, {
      parse_mode: "HTML",
    });
  } catch (err) {
    await safeDeleteMessage(ctx, wait.message_id);
    await ctx.reply(`Debug failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

bot.command("viewpacks", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const u = getUserPacks(uid);
  if (u.packs.length === 0) {
    await ctx.reply(
      "📦 You don't have any sticker packs yet.\nUse 🧩 <b>Stickers</b> to create one!",
      { parse_mode: "HTML" },
    );
    return;
  }
  const lines = u.packs.map(
    (p, i) =>
      `<b>${i + 1}.</b> ${htmlEscape(p.name)}  <i>( ${p.count} stickers )</i>\n   <a href="${htmlEscape(p.link)}">${htmlEscape(p.link)}</a>`,
  );
  await ctx.reply(`📚 <b>Your Sticker Packs</b>\n\n${lines.join("\n\n")}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

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

bot.callbackQuery("home", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  await showHome(ctx, uid);
});

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
    selectedVideoId: undefined,
  });
  await ctx.reply(promptForKind(kind), { parse_mode: "Markdown" });
});

bot.callbackQuery("music:new", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  await showMusicMenu(ctx, uid);
});

bot.callbackQuery(/^music:p:([\w-]{6,32})$/, async (ctx) => {
  const videoId = ctx.match[1];
  const uid = ctx.from.id;
  const s = getState(uid);
  const pick = s.searchResults?.find((r) => r.videoId === videoId);
  if (!pick) {
    await ctx.answerCallbackQuery({ text: "This result expired. Please search again.", show_alert: true });
    return;
  }
  setState(uid, { selectedVideoId: videoId });
  await ctx.answerCallbackQuery({ text: "🎧 Fetching audio…" });
  await deliverAudio(ctx, pick);
});

bot.callbackQuery(/^music:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const page = parseInt(ctx.match[1], 10);
  await renderResultsPage(ctx, uid, page);
});

bot.callbackQuery("music:page:info", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Use ⬅️ and ➡️ to navigate pages" });
});

bot.callbackQuery(/^music:pick:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({
    text: "This result is from an old search — please run a new search.",
    show_alert: true,
  });
});

bot.callbackQuery("stickers:newpack", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  pushHistory(uid);
  setState(uid, {
    mode: "sticker",
    step: "await_pack_name",
    currentPackShortName: undefined,
    pendingPackName: undefined,
  });
  await ctx.reply("✨ *Send your sticker pack name*\n\nGive it a name you'll remember.", {
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("stickers:continue", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const s = getState(uid);
  if (!s.currentPackShortName) {
    await ctx.reply("No open pack — tap ✨ Start New Pack to begin.");
    return;
  }
  const pack = findPack(uid, s.currentPackShortName);
  if (!pack) {
    setState(uid, { currentPackShortName: undefined });
    await ctx.reply("That pack is gone — tap ✨ Start New Pack to begin.");
    return;
  }
  pushHistory(uid);
  setState(uid, {
    mode: "sticker",
    step: "await_media",
    pendingPackName: pack.name,
  });
  await ctx.reply(
    `🎨 Continuing <b>${htmlEscape(pack.name)}</b> ( ${pack.count} stickers so far ).\n` +
      `Send images, videos, or GIFs and I'll add them to this pack.`,
    { parse_mode: "HTML" },
  );
});

bot.callbackQuery("stickers:viewpacks", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  const u = getUserPacks(uid);
  if (u.packs.length === 0) {
    await ctx.reply("📦 No packs yet — tap <b>Create Pack</b> to start one.", {
      parse_mode: "HTML",
    });
    return;
  }
  const lines = u.packs.map(
    (p, i) =>
      `<b>${i + 1}.</b> ${htmlEscape(p.name)}  <i>( ${p.count} stickers )</i>\n   <a href="${htmlEscape(p.link)}">${htmlEscape(p.link)}</a>`,
  );
  await ctx.reply(`📚 <b>Your Sticker Packs</b>\n\n${lines.join("\n\n")}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

bot.on("message:text", async (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

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

  await ctx.reply("Tap /start to open the menu 👋");
});

async function handleMusicQuery(
  ctx: Context,
  query: string,
  kind: "song" | "artist" | "movie" | "lyrics",
): Promise<void> {
  if (!ctx.from) return;
  const uid = ctx.from.id;
  const wait = await ctx.reply("🔎 Searching…");

  const results = await searchMusic(query, kind, 500);
  await safeDeleteMessage(ctx, wait.message_id);

  if (results.length === 0) {
    await ctx.reply("I couldn't find that 😕 Please check the name and try again.");
    return;
  }

  setState(uid, {
    mode: "music",
    step: "results",
    searchResults: results,
    searchQuery: query,
    searchKind: kind,
    selectedVideoId: undefined,
  });
  await renderResultsPage(ctx, uid);
}

async function renderResultsPage(ctx: Context, uid: number, page = 0): Promise<void> {
  const s = getState(uid);
  const all = s.searchResults || [];
  const pageSize = 10;
  const start = page * pageSize;
  const end = Math.min(start + pageSize, all.length);
  const pageResults = all.slice(start, end);
  
  const lines = pageResults.map((r, i) => {
    const safeTitle = r.title.length > 52 ? r.title.slice(0, 49) + "…" : r.title;
    const dur = r.durationFormatted || "?";
    return `<b>${start + i + 1}.</b> ${htmlEscape(safeTitle)} <i>[${htmlEscape(dur)}]</i>`;
  });
  const totalPages = Math.ceil(all.length / pageSize);
  const pageInfo = totalPages > 1 ? `\n\n<i>Page ${page + 1}/${totalPages}</i>` : "";
  const text = `🎧 <b>Results</b>\n\n${lines.join("\n")}${pageInfo}\n\n<i>Tap a number below to download.</i>`;

  setState(uid, { searchPage: page });

  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: resultsMenu(all, page, pageSize),
      });
      return;
    } catch {
    }
  }
  await ctx.reply(text, {
    parse_mode: "HTML",
    reply_markup: resultsMenu(all, page, pageSize),
  });
}

async function deliverAudio(ctx: Context, pick: SearchResult): Promise<void> {
  const status = await ctx.reply("⬇️ Fetching audio… please wait (up to 30s)");
  let downloaded;
  try {
    downloaded = await downloadAsMp3(pick.url, pick.title, pick.channel, pick.videoId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[deliver] download failed:", msg);
    await safeDeleteMessage(ctx, status.message_id);
    await ctx.reply(
      "😕 Couldn't fetch that song — all sources failed.\n\n" +
      "<b>Try:</b>\n• Pick a different result from the list\n• Search again with a slightly different name",
      { parse_mode: "HTML" },
    );
    return;
  }

  await safeDeleteMessage(ctx, status.message_id);
  try {
    await ctx.replyWithAudio(new InputFile(downloaded.filePath), {
      title: downloaded.title,
      performer: downloaded.artist,
      duration: downloaded.durationSec || undefined,
      caption: `🎵 <b>${htmlEscape(downloaded.title)}</b>\n👤 ${htmlEscape(downloaded.artist)}`,
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("[deliver] send failed", err);
    await ctx.reply("😕 Couldn't send the audio. Please try another result.");
  } finally {
    cleanupTempFile(downloaded.filePath);
  }
}

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
    `✅ Pack ready: <b>${htmlEscape(trimmed)}</b>\n\nNow send images, videos, or GIFs to convert into stickers 🎨\n<i>You can send many — I'll add them as fast as possible.</i>`,
    { parse_mode: "HTML" },
  );
}

async function downloadFile(ctx: Context, fileId: string): Promise<Buffer> {
  const file = await ctx.api.getFile(fileId);
  const fpath = file.file_path;
  if (!fpath) throw new Error("missing file_path");
  const url = `https://api.telegram.org/file/bot${TOKEN}/${fpath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function reuseStaticPack(uid: number): string | null {
  const s = getState(uid);
  if (s.currentPackShortName) {
    const existing = findPack(uid, s.currentPackShortName);
    if (existing && existing.kind === "static" && existing.count < STATIC_PACK_LIMIT) {
      return existing.shortName;
    }
  }
  return null;
}

function reuseVideoPack(uid: number): string | null {
  const s = getState(uid);
  if (s.currentPackShortName) {
    const existing = findPack(uid, s.currentPackShortName);
    if (existing && existing.kind === "video" && existing.count < VIDEO_PACK_LIMIT) {
      return existing.shortName;
    }
  }
  return null;
}

function isShortNameTakenError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description || "";
  return (
    d.includes("STICKERSET_INVALID") ||
    d.includes("name is already occupied") ||
    d.includes("SHORT_NAME_OCCUPIED") ||
    d.includes("SHORT_NAME_INVALID") ||
    d.includes("PACK_SHORT_NAME_OCCUPIED") ||
    d.includes("PACK_SHORT_NAME_INVALID")
  );
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

    const existing = reuseStaticPack(uid);
    if (existing) {
      try {
        const tmp = await writeTempFromBuffer(webp, "webp");
        await ctx.api.addStickerToSet(uid, existing, {
          sticker: new InputFile(tmp),
          format: "static",
          emoji_list: ["✨"],
        });
        await cleanupFile(tmp);
        incrementPackCount(uid, existing);
        await replyWithStickerLink(ctx, uid, existing);
        return;
      } catch (err) {
        await handleStickerError(ctx, uid, err, "static");
        return;
      }
    }

    const created = await createStickerPack(ctx, uid, pendingName, webp, "static");
    if (!created) return;
    await replyWithStickerLink(ctx, uid, created);
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

    const existing = reuseVideoPack(uid);
    if (existing) {
      try {
        const tmp = await writeTempFromBuffer(webm, "webm");
        await ctx.api.addStickerToSet(uid, existing, {
          sticker: new InputFile(tmp),
          format: "video",
          emoji_list: ["🎬"],
        });
        await cleanupFile(tmp);
        incrementPackCount(uid, existing);
        await replyWithStickerLink(ctx, uid, existing);
        return;
      } catch (err) {
        await handleStickerError(ctx, uid, err, "video");
        return;
      }
    }

    const created = await createStickerPack(ctx, uid, pendingName, webm, "video");
    if (!created) return;
    await replyWithStickerLink(ctx, uid, created);
  } catch (err) {
    console.error("[sticker video] failed", err);
    await ctx.reply("😕 Couldn't convert that video. Try another file.");
  } finally {
    if (inputPath) await cleanupFile(inputPath);
  }
}

async function createStickerPack(
  ctx: Context,
  uid: number,
  pendingName: string,
  firstSticker: Buffer,
  kind: "static" | "video",
): Promise<string | null> {
  const ext = kind === "video" ? "webm" : "webp";
  const format = kind === "video" ? "video" : "static";
  const emoji = kind === "video" ? "🎬" : "✨";
  const title = pendingName;

  const candidates = [
    makeShortName(pendingName, botUsername, false),
    makeShortName(pendingName, botUsername, true),
    makeShortName(pendingName, botUsername, true),
    makeShortName(pendingName, botUsername, true),
  ];

  const tmp = await writeTempFromBuffer(firstSticker, ext);
  let chosen: string | null = null;

  try {
    for (const shortName of candidates) {
      try {
        await ctx.api.createNewStickerSet(uid, shortName, title, [
          {
            sticker: new InputFile(tmp),
            format,
            emoji_list: [emoji],
          },
        ]);
        chosen = shortName;
        break;
      } catch (err) {
        if (isShortNameTakenError(err)) continue;
        console.error(`[pack create ${kind}] failed`, err);
        await ctx.reply(
          `😕 Couldn't create the pack: ${err instanceof Error ? err.message : "unknown"}`,
        );
        return null;
      }
    }
  } finally {
    await cleanupFile(tmp);
  }

  if (!chosen) {
    await ctx.reply("😕 Couldn't create that pack — please try again with a different name.");
    return null;
  }

  addPack(uid, {
    name: title,
    shortName: chosen,
    link: packLink(chosen),
    kind,
    count: 1,
    createdAt: Date.now(),
  });
  setCurrentPack(uid, chosen);
  setState(uid, { currentPackShortName: chosen });
  return chosen;
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
      setState(uid, { currentPackShortName: undefined });
      return;
    }
  }
  await ctx.reply(`😕 Couldn't add to the pack: ${err instanceof Error ? err.message : "unknown"}`);
}

async function replyWithStickerLink(ctx: Context, uid: number, shortName: string): Promise<void> {
  const pack = findPack(uid, shortName);
  if (!pack) return;
  const text =
    `✅ Added to <b>${htmlEscape(pack.name)}</b>  ( ${pack.count} stickers )\n` +
    `<a href="${htmlEscape(pack.link)}">${htmlEscape(pack.link)}</a>\n\n` +
    `Keep sending media to add more!`;
  await ctx.reply(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

let isShuttingDown = false;
let restartTimeout: NodeJS.Timeout | null = null;

bot.catch((err) => {
  if (isShuttingDown) return;
  const e = err.error;
  if (e instanceof GrammyError && e.description.includes("409")) {
    console.warn("[bot] 409 conflict: another instance is polling. Restarting in 5s…");
    if (restartTimeout) clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      if (!isShuttingDown) {
        console.log("[bot] attempting restart…");
        startBot().catch((err2) => {
          console.error("[bot] restart failed:", err2);
          process.exit(1);
        });
      }
    }, 5000);
    return;
  }
  if (e instanceof GrammyError) {
    console.error("[grammy]", e.description);
  } else if (e instanceof HttpError) {
    console.error("[http]", e);
  } else {
    console.error("[bot]", e);
  }
});

process.on("unhandledRejection", (reason) => {
  if (isShuttingDown) return;
  if (reason instanceof GrammyError && reason.description.includes("409")) {
    console.warn("[bot] 409 in unhandledRejection, restarting…");
    if (restartTimeout) clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      if (!isShuttingDown) {
        startBot().catch(console.error);
      }
    }, 5000);
    return;
  }
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  if (String(err).includes("409")) {
    console.warn("[bot] 409 in uncaughtException, restarting…");
    if (restartTimeout) clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      if (!isShuttingDown) {
        startBot().catch(console.error);
      }
    }, 5000);
    return;
  }
  process.exit(1);
});

async function startBot(): Promise<void> {
  run(bot);
  console.log("[bot] polling started (concurrent mode)");
}

async function main(): Promise<void> {
  await loadStore();
  await initCookies();
  const me = await bot.api.getMe();
  botUsername = me.username;
  console.log(`[bot] starting as @${botUsername}`);
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  await startBot();

  async function shutdown(): Promise<void> {
    isShuttingDown = true;
    console.log("[bot] shutting down…");
    if (restartTimeout) clearTimeout(restartTimeout);
    process.exit(0);
  }
  
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bot] fatal", err);
  process.exit(1);
});