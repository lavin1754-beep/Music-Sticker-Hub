import { InlineKeyboard } from "grammy";

export const WELCOME_MESSAGE = `🎧 *Welcome to Arya — Music & Stickers*

A little corner where your favourite tunes meet your favourite moments.
Hum a lyric, name a song, or hand me a photo — I'll turn the thought into something you can share.

🎵  *Music* — songs, artists, movies & lyrics, delivered as crisp audio
🧩  *Stickers* — your pictures, clips & GIFs, polished into pro-quality packs

Pick where you'd like to begin 👇`;

export const ARYA_FOOTER = "Arya Music • crafted with 💜";

export function homeMenu(audioRecognitionEnabled: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🎵 Music", "mode:music")
    .text("🧩 Stickers", "mode:sticker");
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

export function resultsMenu(results: Array<{ videoId: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  const total = Math.min(results.length, 100);
  for (let i = 0; i < total; i++) {
    kb.text(`${i + 1}`, `music:p:${results[i].videoId}`);
    if ((i + 1) % 5 === 0) kb.row();
  }
  if (total % 5 !== 0) kb.row();
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
