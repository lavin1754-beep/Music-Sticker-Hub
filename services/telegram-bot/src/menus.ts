import { InlineKeyboard } from "grammy";

export const WELCOME_MESSAGE = `🎧 *Welcome to Arya Music* 🎧

Your all-in-one companion for *music* and *stickers* — sleek, fast, and crafted with care.

✨ *What I can do*
🎵  Find and deliver any song — old, new, or trending
🧩  Turn your photos, videos & GIFs into pro-quality stickers

Pick a vibe to get started 👇`;

export const ARYA_FOOTER = "Arya Music • crafted with 💜";

export function homeMenu(audioRecognitionEnabled: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🎵 Music", "mode:music")
    .text("🧩 Stickers", "mode:sticker");
  // audioRecognitionEnabled flag kept for potential future use (currently unused in home menu)
  void audioRecognitionEnabled;
  return kb;
}

export function musicOptionsMenu(audioRecognitionEnabled: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("1️⃣ Song Name", "music:opt:song")
    .text("2️⃣ Artist", "music:opt:artist")
    .row()
    .text("3️⃣ Movie", "music:opt:movie")
    .text("4️⃣ Lyrics", "music:opt:lyrics")
    .row();

  if (audioRecognitionEnabled) {
    kb.text("5️⃣ Voice / Video", "music:opt:audio").row();
  }

  kb.text("⬅️ Back", "back");
  return kb;
}

export function resultsMenu(
  results: Array<{ title: string }>,
  startIdx: number,
  hasMore: boolean,
  hasPrev: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  results.forEach((_r, i) => {
    const num = startIdx + i + 1;
    kb.text(`${num}`, `music:pick:${i}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  if (results.length % 5 !== 0) kb.row();

  if (hasPrev) kb.text("⬅️ Prev", "music:prev");
  if (hasMore) kb.text("➡️ Next", "music:next");
  if (hasPrev || hasMore) kb.row();

  kb.text("🔁 New Search", "music:new").text("⬅️ Back", "back");
  return kb;
}

export function packFullMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Create New Pack", "stickers:newpack")
    .row()
    .text("⬅️ Back", "back");
}

export function stickersStartMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Create Pack", "stickers:newpack")
    .row()
    .text("📦 View My Packs", "stickers:viewpacks")
    .row()
    .text("⬅️ Back", "back");
}
