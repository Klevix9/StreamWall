# StreamWall

Self-hosted multi-stream video wall. Show up to 4 streams/videos on your TV in a layout of your choosing, controlled from your phone.

- **TV display** → `http://<server-ip>:8080/tv`
- **Phone remote** → `http://<server-ip>:8080/`

Supported sources: HLS/IPTV streams (`.m3u8`), YouTube links, Twitch links (channels and VODs), direct video URLs, and local files from your media folder.

---

## 1. Installation

### Option A — Docker (recommended)

Requirements: Docker with the compose plugin.

```bash
# 1. Copy this project folder to your server, then:
cd streamwall

# 2. (Optional) point the media volume at your existing video library.
#    Edit docker-compose.yml and change the line:
#      - ./media:/media
#    to e.g.:
#      - /mnt/storage/videos:/media

# 3. Build and start
docker compose up -d --build
```

The service starts on port **8080** and restarts automatically with the server. Saved streams and wall state are kept in `./data`.

Update after changing code: `docker compose up -d --build`
Logs: `docker compose logs -f` · Stop: `docker compose down`

### Option B — Plain Node.js

Requirements: Node 18+.

```bash
cd streamwall
npm install
npm start
```

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `MEDIA_DIR` | `./media` | Folder scanned for video files |
| `DATA_DIR` | `./data` | Where saved streams/state are stored |

To keep it running, create a systemd unit:

```ini
# /etc/systemd/system/streamwall.service
[Unit]
Description=StreamWall
After=network.target

[Service]
WorkingDirectory=/opt/streamwall
ExecStart=/usr/bin/node server/index.js
Environment=MEDIA_DIR=/mnt/storage/videos
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now streamwall
```

---

## 2. Getting the wall onto your TV

Find your server's LAN IP first (e.g. `192.168.1.50`). The TV URL is then `http://192.168.1.50:8080/tv`.

**Casting (preferred)**
- **Chromecast / Google TV:** open Chrome on a laptop or phone, go to the TV URL, menu → **Cast** → *Cast tab*. Better: on Google TV / Android TV install a browser app (e.g. TV Bro) and open the URL directly — higher quality, nothing else needs to stay on.
- **Android TV / Fire TV:** install a browser from the app store, open the TV URL, go fullscreen.
- **LG / Samsung smart TVs:** use the built-in web browser with the same URL.

**HDMI**
Plug any mini PC or Raspberry Pi into the TV and launch a kiosk browser:

```bash
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required http://192.168.1.50:8080/tv
```

When the page loads you'll see **"Tap once to start playback with sound"** — click/tap it once. Browsers require one interaction before audio is allowed (the kiosk flag above removes even that).

---

## 3. Phone remote

1. On your phone, open `http://<server-ip>:8080/` in the browser.
2. **Install as an app:** browser menu → *Add to Home Screen* (Android/Chrome) or Share → *Add to Home Screen* (iPhone/Safari). It then opens fullscreen like a native app.

The green/red dot in the header shows the connection to the server; the header also shows the TV URL.

---

## 4. Using it

**Layout** — tap one of the 5 layout icons: fullscreen, 2 side-by-side, 2 stacked, 1 big + 2 small, or 2×2 grid. The TV switches instantly.

**Putting media on a screen** — tap a screen card, then pick from:
- **Streams** — your saved list. Add new ones at the bottom (name + URL). Works with `.m3u8`/IPTV URLs, YouTube links, Twitch channels/VODs. Delete with ✕.
- **Files** — everything found in your media folder, including subfolders.
- **URL** — paste any link to play once without saving.

**Sound** — only one screen has audio at a time. Tap the 🔊 button on a card to move sound there.

**Per-screen buttons** — ↻ reloads a stuck stream, ✕ clears the screen.

**Bottom bar** — global Play/Pause and Mute for the whole wall.

Everything syncs live: any change on the phone appears on the TV within a fraction of a second, and multiple phones can be connected at once.

---

## 5. Notes & limits

- **YouTube/Twitch** play through their official embedded players (platform requirement), so seek/pause control for those is limited to what the embed allows.
- **File formats:** browsers natively play `.mp4`, `.webm`, `.m4v`, `.mov` (H.264/VP9/AV1). `.mkv`/`.avi` are listed but may not play depending on codecs — remux if needed: `ffmpeg -i in.mkv -c copy out.mp4`.
- **Performance:** 4 simultaneous streams is real work for the TV-side device. A Chromecast with Google TV handles 4×720p HLS fine; very old smart-TV browsers may struggle.
- **Security:** there is no login. Keep it on your LAN; if you ever expose it to the internet, put it behind a reverse proxy with authentication (e.g. Caddy/nginx + basic auth).

---

## Project layout

```
streamwall/
├── server/index.js      # Node server: state, WebSocket sync, media library, API
├── public/tv.html       # TV display page (video wall)
├── public/remote.html   # Phone remote (PWA)
├── public/manifest.json # PWA manifest
├── docker-compose.yml
├── Dockerfile
├── media/               # your video files (or mount your own folder)
└── data/                # saved streams + wall state (auto-created)
```
