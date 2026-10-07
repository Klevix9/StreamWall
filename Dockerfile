FROM node:20-alpine
# streamlink resolves Twitch (and many other sites') live HLS URLs reliably —
# it tracks Twitch's token/integrity/anti-bot changes so we don't have to.
# Installed from Alpine's community repo (prebuilt, no compilation).
RUN apk add --no-cache streamlink yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server ./server
COPY public ./public
ENV PORT=8080 \
    MEDIA_DIR=/media \
    DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server/index.js"]
