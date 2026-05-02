FROM node:24-bookworm-slim

# ffmpeg for audio/video processing, python3+pip for yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      python3 \
      python3-pip \
      ca-certificates \
    && pip3 install --break-system-packages --upgrade yt-dlp \
    && rm -rf /var/lib/apt/lists/* /root/.cache/pip

RUN corepack enable && corepack prepare pnpm@9 --activate

WORKDIR /app

COPY . .

RUN pnpm install --filter @workspace/telegram-bot --no-frozen-lockfile

RUN mkdir -p services/telegram-bot/data

CMD ["pnpm", "--filter", "@workspace/telegram-bot", "run", "start"]
