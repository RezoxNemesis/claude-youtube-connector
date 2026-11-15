# Claude YouTube Connector

Lets Claude work on **one YouTube channel** through Google's official APIs:

| Where | What it does |
|---|---|
| **PC connector** (`src/server.mjs`, installed in the Claude desktop app as `claude-youtube.mcpb`) | Upload videos from the PC with title, description, tags, thumbnail, schedule and playlist · edit videos · playlists · read/reply to comments · YouTube search · channel analytics · copy finished videos into the Drive queue · upload queued Drive videos |
| **Cloud uploader** (`cloud/run.mjs` + `.github/workflows/upload-from-drive.yml`) | When the PC is off: takes jobs from the Google Drive folder **Claude YouTube Queue**, uploads them to YouTube, then **permanently deletes** the Drive copies to free space |

Pages for Google's consent screen: [home](https://rezoxnemesis.github.io/claude-youtube-connector/) · [privacy](https://rezoxnemesis.github.io/claude-youtube-connector/privacy.html) · [terms](https://rezoxnemesis.github.io/claude-youtube-connector/terms.html)

## Drive queue format

Put the video (and optional thumbnail) in **Claude YouTube Queue** plus a `<name>.youtube.json` job file:

```json
{
  "title": "My film",
  "description": "…",
  "tags": ["animation"],
  "category_id": "1",
  "privacy_status": "public",
  "publish_at": "2026-11-20T18:30:00+05:30",
  "made_for_kids": false,
  "contains_synthetic_media": true,
  "default_language": "hi",
  "playlist_id": "PL…",
  "video_file_name": "my-film.mp4",
  "thumbnail_file_name": "my-film.jpg",
  "upload_after": "2026-11-20T10:00:00+05:30",
  "delete_from_drive_after_upload": true,
  "status": "queued"
}
```

`video_file_id` / `thumbnail_file_id` can be used instead of names. The uploader writes `status`, `attempts`, `last_error` and `youtube_video_id` back into the job, retries up to 3 times, and keeps a short `_upload-log.json` in the folder.

The workflow runs when Claude starts it (`workflow_dispatch`, optionally with one `job_file_id`) and every 2 hours as a safety net.

## Setup (one time)

1. Google Cloud project with **YouTube Data API v3**, **YouTube Analytics API** and **Google Drive API** enabled; OAuth consent screen (External, published) with the scopes `youtube`, `youtube.upload`, `youtube.force-ssl`, `yt-analytics.readonly`, `drive`; a **Web application** OAuth client with redirect URI `http://localhost:8765/oauth2callback`; its JSON downloaded into `~/Downloads`.
2. Install `claude-youtube.mcpb` in the Claude desktop app, then ask Claude to sign in (`youtube_auth_start`).
3. Ask Claude to run `youtube_cloud_key`, and paste the clipboard into a new repository secret **`YT_CLOUD_KEY`**.

Tokens live in `~/.config/claude-youtube` (mode 600) and in the encrypted GitHub secret — never in this repo.

## Cloud tasks (subtitles, translations, publishing)

`.github/workflows/youtube-task.yml` runs `cloud/task.mjs` on a task file in `tasks/…/task.json`: upload subtitle tracks (SRT), set translated titles/descriptions, change privacy, or go public a set time after processing. Example: `tasks/orez-ep1/`.

## YouTube audit note

YouTube's docs say uploads from projects that haven't passed the **API compliance audit** can be locked to private. On 15 Nov 2026 an upload from this project went public normally, but applying for the free audit (<https://support.google.com/youtube/contact/yt_api_form>, answers in `AUDIT.md`) is still the safe move. End screens and info cards have no API — they are set in YouTube Studio.

## Build

```sh
npm install
npm run build   # → dist/claude-youtube.mcpb
```
