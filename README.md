# Artify

A Spotify-style offline music player for iPhone that runs as a home-screen web app. You add audio files you own, and they're stored on the phone and play with no internet connection. You can also import the track lists of your Spotify playlists; songs you've added show up in them automatically.

No server, no build step, no accounts. It's plain HTML/CSS/JS.

## Features

**Look**
- Themes: 8 accent colours (light blue by default) and 4 backgrounds (Dark, True black, Midnight, Plum) in Settings › Theme
- Speaker button in the player: pick AirPods, Bluetooth speakers or AirPlay (iPhone shows its own output picker)

**Library**
- Home, Search and Library tabs, a mini player, a full Now Playing screen, and a queue
- Reads embedded metadata: title, artist, album, album artist, genre, year, track number, cover art, lyrics (MP3/ID3, M4A/AAC, FLAC)
- Songs with several artists ("A, B", "A feat. B", "A & B"…) appear on every artist's page; "Treat as one artist name" in Edit fixes bands like "Simon & Garfunkel"
- Edit song or album info with **genre suggestions** (from your library, the song's language and sound, and the free MusicBrainz database when online) and a language picker
- **Clean up song info**: removes "(Official Video) [HD]" and the like, moves "feat." credits into the artist, fills missing genres
- **Find duplicates**: keeps the best-quality copy and merges likes, plays and playlists
- **Song memories**: attach a note to any song; it shows in Now Playing and is searchable
- **Free music** (Search › Free music, or Your Library › + › Find free music): search the Internet Archive for music that is legally free to share (Creative Commons, public domain, netlabel releases, live concerts from bands that allow taping), preview tracks, and add them straight to your library with cover, licence and source saved
- **Find lyrics online** (Add lyrics › Find lyrics online): searches the free LRCLIB database, previews the first synced lines in time with your song, and downloads the full lyrics when you approve
- **Select several songs** (Select button, or press and hold a song) to add them to a playlist, queue, like, edit, save, remove or delete in one go
- **Synced lyrics** from .lrc files you add (or lyrics embedded in the file), and **lyrics search**: type a line in Search to find the song and play it from that line
- **Quick page**: a widget-style screen with a now-playing card and big one-tap tiles (shuffle Liked, shuffle everything, today's mixes, and up to 6 pinned playlists/albums/mixes). Pin from any ··· menu; optionally open Artify on it every time. The lock screen shows the cover, play/pause, skip and progress while music plays. (iPhone doesn't allow real home-screen widgets or Siri Shortcuts for web apps.)
- **Share to Artify** from other apps on Android and desktop Chrome (it appears in the Share menu and imports the song). On iPhone, web apps can’t appear in the share sheet or receive AirDrop: songs you AirDrop or “Save to Files” land in Files › Downloads, then use Add music.
- **Backup & family sharing**: export the library or a playlist (songs included) as one .zip, import it on another phone
- **Save to Files / Share**: MP3s get the edited tags, cover and lyrics written into the file
- **Spotify playlist import** (Settings › Import Spotify playlists): copies playlist names and track lists only

**Playlists**
- Song picker with search and recommendations when you create a playlist (or tap “Add songs”)
- Drag to reorder (··· › Edit order), automatic 2×2 collage covers or your own photo, folders
- Smart playlists from rules (genre, language, mood, artist, times played, last played, added, liked, tempo, energy, year, length) that update themselves
- Sort and filter every song list (most/least played, recently played, added, title, artist, tempo, length; filter by play count, liked, not played in 30 days, language) plus “Find in…”
- Play counts on every song, and Recently played (Home shelf and full history)

**Made for you** (all automatic)
- Daily Mixes, Most Played, On Repeat, Recently Added, Forgotten Favourites, Songs With Memories
- Genre mixes (similar genres grouped: Hip-Hop & Rap, Electronic & Dance…)
- Moods (Energy Boost, Feel Good, Chill, Focus, Late Night) from each song's analyzed tempo and energy
- Language playlists. An on-device AI (Whisper base, ~77 MB downloaded once) listens to each song to detect the language and spot instrumentals; nothing leaves the phone
- Song radio: an endless queue of similar songs from your library

**Sound & playback** (Settings › Sound)
- *Enhanced audio* (off by default; see note below): 10-band equalizer with presets, a custom curve, and **Smart EQ** that gives each song its own curve from its measured frequency balance; crossfade (0–12 s); volume leveling; karaoke (vocal reduction); effects (8D audio, Concert hall, Night mode)
- Smart transitions (no fade between consecutive album tracks, fades start where a song naturally fades out) and skip silence: these work in both modes
- Smart shuffle, playback speed (pitch stays natural), A–B loop, sleep timer, car mode, swipe/double-tap gestures, listening stats

> **Enhanced audio on iPhone:** it routes audio through Safari's audio engine, which on home-screen apps can pause music when the screen locks or you switch apps. If that happens, turn it off; transitions and skip-silence keep working.

## Put it online (GitHub Pages, free)

1. Create a GitHub account and a new **public** repository (this one is `Artify`).
2. Upload everything in this folder (drag and drop on the repo page works). Skip `.claude/` and `README.md` if you like.
3. In the repo go to **Settings › Pages**. Under "Build and deployment", pick **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute your app is at `https://<your-username>.github.io/Artify/` (live at https://arta2007.github.io/Artify/).

## Install on each iPhone

1. Open the link in **Safari** (it must be Safari).
2. Tap **Share › Add to Home Screen › Add**.
3. Open **Artify** from the home screen, then tap **Add music** and pick files from the Files app.

From then on it works fully offline. Each phone has its own separate library.

Notes:
- **Removing the app from the home screen deletes its music.** Use "Save all to Files" on an album or playlist to keep copies.
- Getting music onto the phone: put files in iCloud Drive from your PC (icloud.com or the iCloud for Windows app), or AirDrop/send them, then add them from Files.
- Formats: MP3, M4A/AAC, FLAC, WAV and AIFF play on iPhone. OGG/Opus may not.

## Updating the app later

Change the files, commit and push. A Git hook in `.githooks/` bumps `CACHE` in `sw.js` automatically on every commit (enable it once per clone with `git config core.hooksPath .githooks`; if you edit on the GitHub website instead, bump it by hand). Phones pick up the new version on the second fresh launch (swipe the app away, open it again).

## Spotify playlist import setup

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), log in, and click **Create app**.
2. Under **Redirect URIs** add your app's exact URL, e.g. `https://arta2007.github.io/Artify/`. The app shows the exact value to copy under Settings › Import Spotify playlists.
3. Tick **Web API**, save, and copy the **Client ID** into the app.
4. Family members who want to import their own playlists must be added under **User Management** in the same Spotify app. Spotify limits development-mode apps to a small number of users and may change its rules for them.

Only playlist metadata is read (scopes: `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`). No audio is downloaded from Spotify.

## Run it locally on your PC

```bash
python -m http.server 8765
```

Then open http://localhost:8765. To try it on a phone it has to be served over HTTPS, so use GitHub Pages.
