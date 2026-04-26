# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/telegram-bot run start` — run the Arya Music Telegram bot

## Telegram Bot — Arya Music

Located at `services/telegram-bot/`. A long-running Node process that polls the Telegram Bot API.

- Token stored in env var `TELEGRAM_BOT_TOKEN`.
- Two strictly separated modules:
  - **🎵 Music** — search by song / artist / movie / lyrics, paginated 10-per-page results, MP3 audio delivery via YouTube source + ffmpeg conversion. Voice/video recognition is hidden by default (no audio fingerprint API key).
  - **🧩 Stickers** — create user-owned packs with a unique `_by_<botusername>` short name + random suffix. Images become 512×512 WebP with transparent borders trimmed; videos/GIFs become 3-second VP9 WEBM. Bulk uploads supported.
- Per-user state and pack registry persisted to JSON in `services/telegram-bot/data/`.
- Commands: `/start`, `/back`, `/viewpacks` (the only command beyond `/start`).
- Run locally via the `Telegram Bot` workflow.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
