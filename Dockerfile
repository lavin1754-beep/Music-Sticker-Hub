FROM node:24-bookworm-slim

# Install system deps: ffmpeg (audio/video), python3+pip (yt-dlp), curl (health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
      curl \
    && pip3 install --break-system-packages --upgrade yt-dlp \
    && yt-dlp --version \
    && ffmpeg -version 2>&1 | head -1 \
    && rm -rf /var/lib/apt/lists/* /root/.cache/pip

# Use pnpm 10 (matches local development)
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

COPY . .

# Install only the telegram-bot package and its deps
RUN pnpm install --filter @workspace/telegram-bot... --no-frozen-lockfile

RUN mkdir -p services/telegram-bot/data

CMD ["pnpm", "--filter", "@workspace/telegram-bot", "run", "start"]
