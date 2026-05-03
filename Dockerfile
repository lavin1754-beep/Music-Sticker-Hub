FROM node:24-bookworm-slim

# Install system deps: ffmpeg, python3, pip, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Force-reinstall yt-dlp to always get the latest version (busts Railway cache)
# Cache-key: 2026-05-03
RUN pip3 install --break-system-packages --upgrade --force-reinstall yt-dlp \
    && yt-dlp --version \
    && ffmpeg -version 2>&1 | head -1

# Use pnpm 10
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY . .

# Install only the telegram-bot package and its deps
RUN pnpm install --filter @workspace/telegram-bot... --no-frozen-lockfile

RUN mkdir -p services/telegram-bot/data

CMD ["pnpm", "--filter", "@workspace/telegram-bot", "run", "start"]
