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

  kb.text("⬅️ Back", "back").text("🏠 Main Menu", "home");
  return kb;
}

export function resultsMenu(
  results: Array<{ videoId: string }>,
  startIdx: number,
  hasMore: boolean,
  hasPrev: boolean,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  results.forEach((r, i) => {
    const num = startIdx + i + 1;
    // Encode the videoId directly so old result-message buttons keep referring
    // to the right song even after the user starts a new search.
    kb.text(`${num}`, `music:p:${r.videoId}`);
    if ((i + 1) % 5 === 0) kb.row();
  });
  if (results.length % 5 !== 0) kb.row();

  if (hasPrev) kb.text("⬅️ Prev", "music:prev");
  if (hasMore) kb.text("➡️ Next", "music:next");
  if (hasPrev || hasMore) kb.row();

  kb.text("🔁 New Search", "music:new").text("⬅️ Back", "back");
  kb.row().text("🏠 Main Menu", "home");
  return kb;
}

export function packFullMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Create New Pack", "stickers:newpack")
    .row()
    .text("⬅️ Back", "back")
    .text("🏠 Main Menu", "home");
}

export function stickersStartMenu(currentPackName?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (currentPackName) {
    // User has an open pack — let them keep adding to it without restarting the flow.
    kb.text(`🎨 Add to "${currentPackName.slice(0, 24)}"`, "stickers:continue").row();
  }
  kb.text("✨ Start New Pack", "stickers:newpack")
    .row()
    .text("📦 View My Packs", "stickers:viewpacks")
    .row()
    .text("⬅️ Back", "back")
    .text("🏠 Main Menu", "home");
  return kb;
}
