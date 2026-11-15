// Shared Google logic for the Claude YouTube Connector.
// Used by the PC connector (src/server.mjs) and the cloud uploader (cloud/run.mjs).
// No npm dependencies: only fetch and Node built-ins.

import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/drive",
];
export const QUEUE_FOLDER_NAME = "Claude YouTube Queue";
export const JOB_SUFFIX = ".youtube.json";
export const LOG_FILE_NAME = "_upload-log.json";

const YT = "https://www.googleapis.com/youtube/v3";
const YT_UPLOAD = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2";
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const CHUNK = 32 * 1024 * 1024; // multiple of 256 KiB
const FOLDER_MIME = "application/vnd.google-apps.folder";

export function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function mimeFor(file) {
  const ext = path.extname(file || "").toLowerCase();
  return (
    {
      ".mp4": "video/mp4",
      ".m4v": "video/mp4",
      ".mov": "video/quicktime",
      ".webm": "video/webm",
      ".mkv": "video/x-matroska",
      ".avi": "video/x-msvideo",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".json": "application/json",
    }[ext] || "application/octet-stream"
  );
}

export function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const driveQ = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---------------------------------------------------------------- OAuth token refresh

export async function tokenRequest(params) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`token endpoint: ${j.error || res.status} ${j.error_description || ""}`.trim());
    e.code = j.error;
    throw e;
  }
  return j;
}

// Simple access-token cache around a refresh token (used by the cloud uploader).
export function refreshTokenAuth({ client_id, client_secret, refresh_token }) {
  let token = null;
  let expiry = 0;
  return async () => {
    if (token && expiry - Date.now() > 60_000) return token;
    const j = await tokenRequest({ client_id, client_secret, refresh_token, grant_type: "refresh_token" });
    token = j.access_token;
    expiry = Date.now() + (j.expires_in || 3600) * 1000;
    return token;
  };
}

// ---------------------------------------------------------------- client

export function createGoogle(getAccessToken, log = () => {}) {
  async function apiError(res) {
    const text = await res.text().catch(() => "");
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(text);
      const e = j.error || {};
      const reason = e.errors && e.errors[0] && e.errors[0].reason;
      msg = `${res.status} ${reason ? reason + ": " : ""}${e.message || text}`;
    } catch {
      if (text) msg += ` ${text.slice(0, 500)}`;
    }
    const err = new Error(msg);
    err.status = res.status;
    return err;
  }

  async function call(method, url, { json, body, headers } = {}) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(json !== undefined ? { "Content-Type": "application/json; charset=UTF-8" } : {}),
        ...(headers || {}),
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
    if (!res.ok) throw await apiError(res);
    if (res.status === 204) return {};
    const t = await res.text();
    return t ? JSON.parse(t) : {};
  }

  const yt = (method, resource, params, json) => call(method, `${YT}/${resource}${qs(params)}`, { json });
  const drive = (method, resource, params, json) => call(method, `${DRIVE}/${resource}${qs(params)}`, { json });

  // ------------------------------------------------ YouTube basics

  let channelCache = null;
  async function myChannel(force = false) {
    if (channelCache && !force) return channelCache;
    const j = await yt("GET", "channels", { part: "snippet,statistics,contentDetails,status,brandingSettings", mine: "true" });
    if (!j.items || !j.items.length) throw new Error("This Google account has no YouTube channel.");
    channelCache = j.items[0];
    return channelCache;
  }

  async function getVideos(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await yt("GET", "videos", { part: "snippet,status,statistics,contentDetails", id: ids.slice(i, i + 50).join(",") });
      out.push(...(j.items || []));
    }
    return out;
  }

  async function setThumbnailBytes(videoId, bytes, mime) {
    if (bytes.length > 2 * 1024 * 1024) throw new Error("Thumbnail must be 2 MB or smaller (JPG/PNG, 1280x720 recommended).");
    const token = await getAccessToken();
    const res = await fetch(`${YT_UPLOAD}/thumbnails/set${qs({ videoId, uploadType: "media" })}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
      body: bytes,
    });
    if (!res.ok) throw await apiError(res);
    return res.json();
  }

  async function addToPlaylist(playlistId, videoId, position) {
    return yt("POST", "playlistItems", { part: "snippet" }, {
      snippet: {
        playlistId,
        resourceId: { kind: "youtube#video", videoId },
        ...(position !== undefined ? { position } : {}),
      },
    });
  }

  // ------------------------------------------------ resumable uploads (YouTube and Drive)

  // Push `size` bytes to a resumable session. getChunk(offset, len) returns a Buffer.
  async function pushResumable(sessionUrl, size, getChunk, onProgress = () => {}) {
    let offset = 0;
    let retries = 0;
    const queryOffset = async () => {
      const tk = await getAccessToken();
      const res = await fetch(sessionUrl, {
        method: "PUT",
        headers: { Authorization: `Bearer ${tk}`, "Content-Range": `bytes */${size}`, "Content-Length": "0" },
      });
      if (res.status === 200 || res.status === 201) return { done: true, result: await res.json() };
      if (res.status === 308) {
        const r = res.headers.get("range");
        return { done: false, offset: r ? Number(r.split("-")[1]) + 1 : 0 };
      }
      throw await apiError(res);
    };
    for (;;) {
      const len = Math.min(CHUNK, size - offset);
      try {
        const chunk = len > 0 ? await getChunk(offset, len) : Buffer.alloc(0);
        const tk = await getAccessToken();
        const res = await fetch(sessionUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${tk}`,
            "Content-Length": String(chunk.length),
            "Content-Range": chunk.length ? `bytes ${offset}-${offset + chunk.length - 1}/${size}` : `bytes */${size}`,
          },
          body: chunk,
        });
        if (res.status === 200 || res.status === 201) {
          onProgress(size, size);
          return res.json();
        }
        if (res.status === 308) {
          const r = res.headers.get("range");
          offset = r ? Number(r.split("-")[1]) + 1 : 0;
          retries = 0;
          onProgress(offset, size);
          continue;
        }
        if (res.status >= 500 || res.status === 429) throw Object.assign(new Error(`server ${res.status}`), { retryable: true });
        throw await apiError(res);
      } catch (e) {
        const retryable = e.retryable || e.name === "TypeError" || /fetch failed|ECONNRESET|socket|ETIMEDOUT|terminated/i.test(String(e.message));
        if (!retryable || ++retries > 8) throw e;
        log(`upload hiccup (${e.message}); retry ${retries}`);
        await sleep(Math.min(60_000, 2 ** retries * 1000));
        const q = await queryOffset();
        if (q.done) return q.result;
        offset = q.offset;
      }
    }
  }

  function buildVideoResource(m) {
    const snippet = { title: m.title, description: m.description || "", categoryId: String(m.category_id || "1") };
    if (m.tags && m.tags.length) snippet.tags = m.tags;
    if (m.default_language) {
      snippet.defaultLanguage = m.default_language;
      snippet.defaultAudioLanguage = m.default_language;
    }
    const status = {
      privacyStatus: m.publish_at ? "private" : m.privacy_status || "private",
      selfDeclaredMadeForKids: !!m.made_for_kids,
      embeddable: true,
      license: "youtube",
      publicStatsViewable: true,
    };
    if (m.publish_at) status.publishAt = m.publish_at;
    if (m.contains_synthetic_media !== undefined && m.contains_synthetic_media !== null) {
      status.containsSyntheticMedia = !!m.contains_synthetic_media;
    }
    return { snippet, status };
  }

  // Upload a video to YouTube from any byte source. meta uses snake_case job fields.
  async function uploadVideo({ size, mime, getChunk, meta, onProgress }) {
    if (!meta || !meta.title) throw new Error("A title is required.");
    const token = await getAccessToken();
    const init = await fetch(
      `${YT_UPLOAD}/videos${qs({
        uploadType: "resumable",
        part: "snippet,status",
        notifySubscribers: meta.notify_subscribers === false ? "false" : "true",
      })}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(size),
          "X-Upload-Content-Type": mime || "video/*",
        },
        body: JSON.stringify(buildVideoResource(meta)),
      }
    );
    if (!init.ok) throw await apiError(init);
    const session = init.headers.get("location");
    if (!session) throw new Error("YouTube did not return an upload session.");
    return pushResumable(session, size, getChunk, onProgress);
  }

  // ------------------------------------------------ local file sources

  async function localSource(filePath) {
    const file = expandHome(filePath);
    const st = await fsp.stat(file);
    if (!st.isFile()) throw new Error(`${file} is not a file`);
    const fh = await fsp.open(file, "r");
    const getChunk = async (start, len) => {
      const buf = Buffer.alloc(len);
      let off = 0;
      while (off < len) {
        const { bytesRead } = await fh.read(buf, off, len - off, start + off);
        if (!bytesRead) break;
        off += bytesRead;
      }
      return off === len ? buf : buf.subarray(0, off);
    };
    return { file, size: st.size, mime: mimeFor(file), getChunk, close: () => fh.close() };
  }

  // ------------------------------------------------ Drive

  async function driveGet(fileId, fields = "id,name,size,mimeType,parents,modifiedTime,createdTime") {
    return drive("GET", `files/${fileId}`, { fields, supportsAllDrives: "true" });
  }

  function driveSource(file) {
    const size = Number(file.size);
    const getChunk = async (start, len) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const tk = await getAccessToken();
          const res = await fetch(`${DRIVE}/files/${file.id}?alt=media&supportsAllDrives=true`, {
            headers: { Authorization: `Bearer ${tk}`, Range: `bytes=${start}-${start + len - 1}` },
          });
          if (!res.ok && res.status !== 206) throw await apiError(res);
          return Buffer.from(await res.arrayBuffer());
        } catch (e) {
          if (attempt >= 5 || (e.status && e.status < 500 && e.status !== 429)) throw e;
          await sleep(2 ** attempt * 1000);
        }
      }
    };
    return { size, mime: file.mimeType && file.mimeType.startsWith("video/") ? file.mimeType : mimeFor(file.name), getChunk };
  }

  async function driveDownload(fileId) {
    const tk = await getAccessToken();
    const res = await fetch(`${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${tk}` } });
    if (!res.ok) throw await apiError(res);
    return Buffer.from(await res.arrayBuffer());
  }

  async function driveList(q, fields = "files(id,name,size,mimeType,modifiedTime,createdTime,parents)", orderBy = "createdTime") {
    const files = [];
    let pageToken;
    do {
      const j = await drive("GET", "files", { q, fields: `nextPageToken,${fields}`, pageSize: 200, orderBy, pageToken, spaces: "drive" });
      files.push(...(j.files || []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return files;
  }

  async function queueFolder(create = true) {
    const found = await driveList(`name = '${driveQ(QUEUE_FOLDER_NAME)}' and mimeType = '${FOLDER_MIME}' and trashed = false`, "files(id,name,createdTime)");
    if (found.length) return found[0];
    if (!create) return null;
    return drive("POST", "files", { fields: "id,name" }, { name: QUEUE_FOLDER_NAME, mimeType: FOLDER_MIME });
  }

  async function findInFolder(folderId, name) {
    const files = await driveList(`'${folderId}' in parents and name = '${driveQ(name)}' and trashed = false`);
    return files[0] || null;
  }

  // Create a small text/JSON file with content in one request.
  async function driveCreateText(name, parentId, text, mime = "application/json") {
    const boundary = "cyb" + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [parentId], mimeType: mime }) +
      `\r\n--${boundary}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n` +
      text +
      `\r\n--${boundary}--`;
    return call("POST", `${DRIVE_UPLOAD}/files${qs({ uploadType: "multipart", fields: "id,name" })}`, {
      body,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
  }

  async function driveUpdateText(fileId, text, mime = "application/json") {
    return call("PATCH", `${DRIVE_UPLOAD}/files/${fileId}${qs({ uploadType: "media", fields: "id" })}`, {
      body: text,
      headers: { "Content-Type": `${mime}; charset=UTF-8` },
    });
  }

  // Upload a local file into a Drive folder (resumable, any size).
  async function driveUploadLocal(filePath, parentId, name, onProgress) {
    const src = await localSource(filePath);
    try {
      const token = await getAccessToken();
      const init = await fetch(`${DRIVE_UPLOAD}/files${qs({ uploadType: "resumable", fields: "id,name,size,mimeType" })}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": src.mime,
          "X-Upload-Content-Length": String(src.size),
        },
        body: JSON.stringify({ name: name || path.basename(src.file), parents: [parentId] }),
      });
      if (!init.ok) throw await apiError(init);
      return await pushResumable(init.headers.get("location"), src.size, src.getChunk, onProgress);
    } finally {
      await src.close();
    }
  }

  // Permanently delete (not trash) so the space is freed straight away.
  async function driveDelete(fileId) {
    try {
      await drive("DELETE", `files/${fileId}`, { supportsAllDrives: "true" });
      return true;
    } catch (e) {
      if (e.status === 404) return true;
      throw e;
    }
  }

  // ------------------------------------------------ queue

  async function readJob(jobFileId) {
    const raw = (await driveDownload(jobFileId)).toString("utf8");
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Job file is not valid JSON.");
    }
  }

  async function writeJob(jobFileId, job) {
    job.updated_at = new Date().toISOString();
    await driveUpdateText(jobFileId, JSON.stringify(job, null, 2));
  }

  async function listQueue() {
    const folder = await queueFolder(false);
    if (!folder) return { folder: null, jobs: [] };
    const files = await driveList(`'${folder.id}' in parents and trashed = false`);
    const jobs = [];
    for (const f of files.filter((x) => x.name.endsWith(JOB_SUFFIX))) {
      let job = null;
      try {
        job = await readJob(f.id);
      } catch (e) {
        job = { status: "invalid", last_error: e.message };
      }
      jobs.push({ job_file_id: f.id, job_file_name: f.name, ...job });
    }
    const others = files
      .filter((x) => !x.name.endsWith(JOB_SUFFIX) && x.name !== LOG_FILE_NAME)
      .map((x) => ({ id: x.id, name: x.name, size_mb: x.size ? +(Number(x.size) / 1048576).toFixed(1) : null }));
    return { folder, jobs, other_files: others };
  }

  async function appendLog(folderId, entry) {
    try {
      const existing = await findInFolder(folderId, LOG_FILE_NAME);
      let list = [];
      if (existing) {
        try {
          list = JSON.parse((await driveDownload(existing.id)).toString("utf8"));
        } catch {}
      }
      list.unshift(entry);
      list = list.slice(0, 200);
      if (existing) await driveUpdateText(existing.id, JSON.stringify(list, null, 2));
      else await driveCreateText(LOG_FILE_NAME, folderId, JSON.stringify(list, null, 2));
    } catch (e) {
      log(`could not write upload log: ${e.message}`);
    }
  }

  async function resolveDriveFile(folderId, id, name) {
    if (id) return driveGet(id);
    if (name) {
      const f = await findInFolder(folderId, name);
      if (f) return f;
      throw new Error(`File "${name}" not found in the "${QUEUE_FOLDER_NAME}" folder.`);
    }
    return null;
  }

  // Process one queued job: Drive → YouTube, then permanently delete the Drive copies.
  async function processJob(jobFileId, { runner = "unknown", force = false, onProgress } = {}) {
    const meta = await driveGet(jobFileId, "id,name,parents");
    const folderId = (meta.parents || [])[0];
    const job = await readJob(jobFileId);
    const now = Date.now();
    const label = job.title || meta.name;

    if (!force) {
      if (job.status === "failed") return { skipped: "failed earlier (fix the job and set status to queued)", title: label };
      if (job.status === "uploading" && job.updated_at && now - Date.parse(job.updated_at) < 3 * 3600_000) {
        return { skipped: `already being uploaded by ${job.runner || "another runner"}`, title: label };
      }
      if (job.upload_after && Date.parse(job.upload_after) > now) return { skipped: `waiting until ${job.upload_after}`, title: label };
    }

    const video = await resolveDriveFile(folderId, job.video_file_id, job.video_file_name);
    if (!video && !job.youtube_video_id) throw new Error("Job has no video_file_id or video_file_name.");
    const thumb = await resolveDriveFile(folderId, job.thumbnail_file_id, job.thumbnail_file_name).catch(() => null);

    let videoId = job.youtube_video_id;
    const extras = {};
    try {
      if (!videoId) {
        job.status = "uploading";
        job.runner = runner;
        job.attempts = (job.attempts || 0) + 1;
        await writeJob(jobFileId, job);
        const src = driveSource(video);
        log(`uploading "${label}" (${(src.size / 1048576).toFixed(1)} MB) from Drive`);
        const res = await uploadVideo({ size: src.size, mime: src.mime, getChunk: src.getChunk, meta: job, onProgress });
        videoId = res.id;
        job.youtube_video_id = videoId;
        job.status = "uploaded";
        job.last_error = null;
        await writeJob(jobFileId, job);
      }
      if (thumb && !job.thumbnail_done) {
        try {
          const bytes = await driveDownload(thumb.id);
          await setThumbnailBytes(videoId, bytes, mimeFor(thumb.name));
          extras.thumbnail = "set";
        } catch (e) {
          extras.thumbnail = `failed: ${e.message}`;
        }
      }
      if (job.playlist_id && !job.playlist_done) {
        try {
          await addToPlaylist(job.playlist_id, videoId);
          extras.playlist = "added";
        } catch (e) {
          extras.playlist = `failed: ${e.message}`;
        }
      }
    } catch (e) {
      job.status = (job.attempts || 0) >= 3 ? "failed" : "queued";
      job.last_error = e.message;
      await writeJob(jobFileId, job).catch(() => {});
      throw e;
    }

    const [fresh] = await getVideos([videoId]).catch(() => []);
    const deleted = [];
    if (job.delete_from_drive_after_upload !== false) {
      for (const f of [video, thumb, { id: jobFileId, name: meta.name }]) {
        if (!f) continue;
        try {
          await driveDelete(f.id);
          deleted.push(f.name);
        } catch (e) {
          log(`could not delete ${f.name}: ${e.message}`);
        }
      }
    }
    const result = {
      title: label,
      youtube_video_id: videoId,
      url: `https://youtu.be/${videoId}`,
      privacy: fresh && fresh.status && fresh.status.privacyStatus,
      publish_at: fresh && fresh.status && fresh.status.publishAt,
      runner,
      ...extras,
      deleted_from_drive: deleted,
      finished_at: new Date().toISOString(),
    };
    if (folderId) await appendLog(folderId, result);
    return result;
  }

  async function analytics(params) {
    return call("GET", `${ANALYTICS}/reports${qs({ ids: "channel==MINE", ...params })}`);
  }

  // ------------------------------------------------ captions & translations

  async function listCaptions(videoId) {
    const j = await yt("GET", "captions", { part: "snippet", videoId });
    return (j.items || []).map((c) => ({ id: c.id, language: c.snippet.language, name: c.snippet.name, trackKind: c.snippet.trackKind, isDraft: c.snippet.isDraft, status: c.snippet.status }));
  }

  // Add (or replace) a subtitle track. text: SRT or WebVTT content.
  async function uploadCaption(videoId, language, name, text) {
    const existing = (await listCaptions(videoId)).find((c) => c.language === language && c.name === name && c.trackKind !== "asr");
    const boundary = "cap" + Math.random().toString(36).slice(2);
    const meta = existing ? { id: existing.id, snippet: { isDraft: false } } : { snippet: { videoId, language, name, isDraft: false } };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${text}\r\n--${boundary}--`;
    const r = await call(existing ? "PUT" : "POST", `${YT_UPLOAD}/captions${qs({ part: "snippet", uploadType: "multipart" })}`, {
      body: Buffer.from(body, "utf8"),
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    });
    return { id: r.id, language, name, replaced: !!existing };
  }

  // Set translated titles/descriptions. localizations: { hi: {title, description}, es: {...} }.
  async function setLocalizations(videoId, defaultLanguage, localizations) {
    const j = await yt("GET", "videos", { part: "snippet,localizations", id: videoId });
    const v = (j.items || [])[0];
    if (!v) throw new Error(`Video ${videoId} not found.`);
    const s = v.snippet;
    const snippet = {
      title: s.title,
      description: s.description,
      categoryId: s.categoryId,
      tags: s.tags || [],
      defaultLanguage: defaultLanguage || s.defaultLanguage || "en",
      ...(s.defaultAudioLanguage ? { defaultAudioLanguage: s.defaultAudioLanguage } : {}),
    };
    const merged = { ...(v.localizations || {}), ...localizations };
    delete merged[snippet.defaultLanguage];
    const r = await yt("PUT", "videos", { part: "snippet,localizations" }, { id: videoId, snippet, localizations: merged });
    return { id: r.id, default_language: snippet.defaultLanguage, languages: Object.keys(r.localizations || {}) };
  }

  async function processing(videoId) {
    const j = await yt("GET", "videos", { part: "status,processingDetails,contentDetails", id: videoId });
    const v = (j.items || [])[0];
    if (!v) throw new Error(`Video ${videoId} not found.`);
    return {
      privacyStatus: v.status.privacyStatus,
      uploadStatus: v.status.uploadStatus,
      processingStatus: v.processingDetails && v.processingDetails.processingStatus,
      duration: v.contentDetails && v.contentDetails.duration,
    };
  }

  return {
    call,
    yt,
    drive,
    myChannel,
    getVideos,
    setThumbnailBytes,
    addToPlaylist,
    uploadVideo,
    localSource,
    driveGet,
    driveSource,
    driveDownload,
    driveList,
    queueFolder,
    findInFolder,
    driveCreateText,
    driveUploadLocal,
    driveDelete,
    readJob,
    writeJob,
    listQueue,
    processJob,
    analytics,
    listCaptions,
    uploadCaption,
    setLocalizations,
    processing,
  };
}

export function slimVideo(v) {
  if (!v) return v;
  const s = v.snippet || {};
  const st = v.status || {};
  return {
    id: v.id,
    url: `https://youtu.be/${v.id}`,
    title: s.title,
    description: s.description,
    tags: s.tags,
    categoryId: s.categoryId,
    publishedAt: s.publishedAt,
    thumbnail: s.thumbnails && (s.thumbnails.maxres || s.thumbnails.high || s.thumbnails.default || {}).url,
    privacyStatus: st.privacyStatus,
    publishAt: st.publishAt,
    uploadStatus: st.uploadStatus,
    rejectionReason: st.rejectionReason,
    failureReason: st.failureReason,
    madeForKids: st.madeForKids,
    containsSyntheticMedia: st.containsSyntheticMedia,
    duration: v.contentDetails && v.contentDetails.duration,
    stats: v.statistics,
  };
}
