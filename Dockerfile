FROM node:20-slim

# Chromium deps for Puppeteer
RUN apt-get update && apt-get install -y \
    wget ca-certificates fonts-liberation libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libatspi2.0-0 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libpango-1.0-0 libcairo2 libcups2 libnss3 libxss1 libxtst6 \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./

RUN npm install --omit=dev

# Use a consistent cache dir and install Chrome there
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=false
RUN mkdir -p /app/.cache/puppeteer
RUN npx --yes @puppeteer/browsers install chrome@127.0.6533.88 --path=/app/.cache/puppeteer --platform=linux --arch=x64

COPY server.js ./

ENV NODE_ENV=production

CMD ["node", "server.js"]
