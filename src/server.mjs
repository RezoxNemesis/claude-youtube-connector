// Claude YouTube Connector — PC side.
// A local MCP server the Claude desktop app runs (installed as a .mcpb), so Claude can work
// on the owner's YouTube channel and Google Drive queue through Google's official APIs.
// Secrets stay on this PC in ~/.config/claude-youtube (file mode 600).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  SCOPES,
  QUEUE_FOLDER_NAME,
  JOB_SUFFIX,
  createGoogle,
  tokenRequest,
  slimVideo,
  expandHome,
  mimeFor,
} from "./core.mjs";

const VERSION = "1.2.0";
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "claude-youtube");
const CLIENT_FILE = path.join(CONFIG_DIR, "client_secret.json");
const TOKEN_FILE = path.join(CONFIG_DIR, "token.json"); // the main channel (unchanged location)
const CHANNELS_DIR = path.join(CONFIG_DIR, "channels"); // one token file per extra channel
const CHANNELS_INDEX = path.join(CONFIG_DIR, "channels.json"); // key -> { title, handle, id }
const MAIN = "main";
const CLOUD_REPO = "RezoxNemesis/claude-youtube-connector";

const log = (...a) => console.error("[claude-youtube]", ...a);
const ok = (data) => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (m) => ({ content: [{ type: "text", text: `Error: ${m}` }], isError: true });

async function writePrivate(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(file, data, { mode: 0o600 });
  await fsp.chmod(file, 0o600).catch(() => {});
}

// ---------------------------------------------------------------- OAuth client file

function parseClientJson(raw) {
  const j = JSON.parse(raw);
  const c = j.web || j.installed || j;
  if (!c.client_id || !c.client_secret) throw new Error("client file has no client_id/client_secret");
  return { client_id: c.client_id, client_secret: c.client_secret };
}

async function findClientFile() {
  const configured = process.env.YT_CLIENT_SECRET_FILE;
  if (configured && !configured.includes("${") && fs.existsSync(expandHome(configured))) return expandHome(configured);
  if (fs.existsSync(CLIENT_FILE)) return CLIENT_FILE;
  let best = null;
  for (const dir of [path.join(os.homedir(), "Downloads"), path.join(os.homedir(), "Desktop"), os.homedir()]) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^client_secret.*\.json$/i.test(n)) continue;
      const full = path.join(dir, n);
      try {
        const st = await fsp.stat(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs };
      } catch {}
    }
  }
  return best ? best.full : null;
}

let cachedClient = null;
async function loadClient() {
  if (cachedClient) return cachedClient;
  const file = await findClientFile();
  if (!file) {
    throw new Error(
      `No Google OAuth client file found. Download it from Google Cloud (Google Auth Platform → Clients → Download JSON) into ~/Downloads, or save it as ${CLIENT_FILE}`
    );
  }
  const raw = await fsp.readFile(file, "utf8");
  cachedClient = parseClientJson(raw);
  if (file !== CLIENT_FILE) await writePrivate(CLIENT_FILE, raw); // keep a private copy
  return cachedClient;
}

// ---------------------------------------------------------------- tokens

// ---------------------------------------------------------------- channels
// Several YouTube channels (e.g. brand channels of one Google login) can be signed in.
// "main" keeps the original token.json; every other channel has channels/<key>.json.
// Each tool call runs inside ctx with the channel it asked for (default: main).

const ctx = new AsyncLocalStorage();
const currentKey = () => (ctx.getStore() && ctx.getStore().key) || MAIN;
const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "channel";
const tokenFile = (key) => (key === MAIN ? TOKEN_FILE : path.join(CHANNELS_DIR, `${slug(key)}.json`));

async function loadIndex() {
  try {
    return JSON.parse(await fsp.readFile(CHANNELS_INDEX, "utf8"));
  } catch {
    return {};
  }
}
async function saveIndexEntry(key, ch) {
  const idx = await loadIndex();
  idx[key] = { title: ch.snippet.title, handle: ch.snippet.customUrl || null, id: ch.id };
  await writePrivate(CHANNELS_INDEX, JSON.stringify(idx, null, 2));
  return idx[key];
}
async function knownKeys() {
  const keys = new Set([MAIN, ...Object.keys(await loadIndex())]);
  try {
    for (const n of await fsp.readdir(CHANNELS_DIR)) if (n.endsWith(".json")) keys.add(n.slice(0, -5));
  } catch {}
  return [...keys];
}
// Accepts a key ("main", "new-light"), a channel title ("New Light"), a handle ("@NewLightScience") or a channel id.
async function resolveChannel(input) {
  if (!input) return MAIN;
  const raw = String(input).trim();
  const low = raw.toLowerCase().replace(/^@/, "");
  const idx = await loadIndex();
  for (const key of await knownKeys()) {
    const e = idx[key] || {};
    const cands = [key, slug(key), e.title, e.handle, e.id].filter(Boolean).map((x) => String(x).toLowerCase().replace(/^@/, ""));
    if (cands.includes(low) || cands.includes(slug(raw))) return key;
  }
  const list = (await knownKeys()).map((k) => (idx[k] ? `${k} (${idx[k].title}${idx[k].handle ? ", " + idx[k].handle : ""})` : k)).join("; ");
  throw new Error(`Unknown channel "${raw}". Signed-in channels: ${list}. To add one, call youtube_auth_start with channel set to its name.`);
}

async function loadToken(key = currentKey()) {
  try {
    return JSON.parse(await fsp.readFile(tokenFile(key), "utf8"));
  } catch {
    return null;
  }
}
const saveToken = (t, key = currentKey()) => writePrivate(tokenFile(key), JSON.stringify(t, null, 2));

const refreshingByKey = new Map();
async function getAccessTokenFor(key) {
  const tok = await loadToken(key);
  if (!tok || !tok.refresh_token) {
    throw new Error(
      key === MAIN
        ? "Not connected to YouTube yet. Call youtube_auth_start and sign in with the channel's Google account."
        : `Channel "${key}" is not signed in. Call youtube_auth_start with channel "${key}".`
    );
  }
  if (tok.access_token && tok.expiry && tok.expiry - Date.now() > 60_000) return tok.access_token;
  let refreshing = refreshingByKey.get(key);
  if (!refreshing) {
    refreshing = (async () => {
      const client = await loadClient();
      try {
        const j = await tokenRequest({
          client_id: client.client_id,
          client_secret: client.client_secret,
          refresh_token: tok.refresh_token,
          grant_type: "refresh_token",
        });
        const next = { ...tok, access_token: j.access_token, expiry: Date.now() + (j.expires_in || 3600) * 1000, scope: j.scope || tok.scope };
        await saveToken(next, key);
        return next.access_token;
      } catch (e) {
        if (e.code === "invalid_grant") throw new Error(`YouTube sign-in for "${key}" expired or was revoked. Call youtube_auth_start${key === MAIN ? "" : ` with channel "${key}"`} to sign in again.`);
        throw e;
      } finally {
        setTimeout(() => refreshingByKey.delete(key), 0);
      }
    })();
    refreshingByKey.set(key, refreshing);
  }
  return refreshing;
}
const getAccessToken = () => getAccessTokenFor(currentKey());

// One Google client per channel. The Google Drive queue always belongs to the main sign-in.
const clients = new Map();
const gFor = (key) => {
  if (!clients.has(key)) clients.set(key, createGoogle(() => getAccessTokenFor(key), log));
  return clients.get(key);
};
const DRIVE_PARTS = /^(drive|queueFolder|findInFolder|readJob|writeJob|listQueue|appendLog|resolveDriveFile|processJob)/;
const g = new Proxy({}, { get: (_, prop) => gFor(typeof prop === "string" && DRIVE_PARTS.test(prop) ? MAIN : currentKey())[prop] });

// ---------------------------------------------------------------- sign-in flow (loopback)

const auth = { servers: [], state: null, verifier: null, status: "idle", error: null, timer: null, key: MAIN, channel: null };
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function stopAuthServers() {
  for (const s of auth.servers) {
    try {
      s.close();
    } catch {}
  }
  auth.servers = [];
  if (auth.timer) clearTimeout(auth.timer);
  auth.timer = null;
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#f1f1f1;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#212121;padding:32px 40px;border-radius:16px;max-width:460px;text-align:center}h1{margin:0 0 8px;font-size:22px}p{color:#aaa;line-height:1.5}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;

async function handleCallback(req, res) {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname !== "/oauth2callback") return void res.writeHead(404).end();
  const send = (code, title, body) => {
    res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page(title, body));
  };
  if (u.searchParams.get("state") !== auth.state) return send(400, "Sign-in link expired", "Ask Claude to start the YouTube sign-in again.");
  const err = u.searchParams.get("error");
  if (err) {
    auth.status = "error";
    auth.error = err;
    send(400, "Sign-in cancelled", `Google returned: ${err}. You can close this tab.`);
    return void setTimeout(stopAuthServers, 500);
  }
  try {
    const client = await loadClient();
    const j = await tokenRequest({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code: u.searchParams.get("code"),
      code_verifier: auth.verifier,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
    });
    const key = auth.key || MAIN;
    const prev = (await loadToken(key)) || {};
    const tok = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || prev.refresh_token,
      expiry: Date.now() + (j.expires_in || 3600) * 1000,
      scope: j.scope,
      created: new Date().toISOString(),
    };
    if (!tok.refresh_token) throw new Error("Google did not return a refresh token");
    await saveToken(tok, key);
    clients.delete(key);
    let chTitle = "your channel";
    try {
      const ch = await gFor(key).myChannel(true);
      auth.channel = await saveIndexEntry(key, ch);
      chTitle = ch.snippet.title;
    } catch (e) {
      auth.channel = null;
      log("channel lookup after sign-in", e);
    }
    auth.status = "connected";
    auth.error = null;
    send(200, "YouTube connected ✓", `Claude can now work on ${chTitle}. You can close this tab.`);
  } catch (e) {
    auth.status = "error";
    auth.error = String(e.message || e);
    send(500, "Sign-in failed", auth.error);
  }
  setTimeout(stopAuthServers, 500);
}

function listen(host) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => handleCallback(req, res).catch((e) => res.writeHead(500).end(String(e))));
    s.once("error", (e) => {
      log(`callback listener on ${host} failed: ${e.code || e.message}`);
      resolve(null);
    });
    s.listen(PORT, host, () => resolve(s));
  });
}

function runDetached(cmd, args) {
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

function openInBrowser(url) {
  if (process.platform === "darwin") return runDetached("open", [url]);
  if (process.platform === "win32") return runDetached("cmd", ["/c", "start", "", url]);
  return runDetached("xdg-open", [url]);
}

async function startAuth(openBrowser, key = MAIN) {
  const client = await loadClient();
  auth.key = key;
  auth.channel = null;
  stopAuthServers();
  const servers = (await Promise.all([listen("127.0.0.1"), listen("::1")])).filter(Boolean);
  if (!servers.length) throw new Error(`Port ${PORT} is busy on this PC; close whatever uses it and try again.`);
  auth.servers = servers;
  auth.state = b64url(crypto.randomBytes(24));
  auth.verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(auth.verifier).digest());
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      // Extra channels only need YouTube; the Drive queue stays with the main sign-in.
      scope: (key === MAIN ? SCOPES : SCOPES.filter((sc) => !sc.includes("/drive"))).join(" "),
      access_type: "offline",
      prompt: key === MAIN ? "consent" : "select_account consent",
      include_granted_scopes: "true",
      state: auth.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  auth.status = "waiting";
  auth.error = null;
  auth.timer = setTimeout(() => {
    if (auth.status === "waiting") auth.status = "expired";
    stopAuthServers();
  }, 15 * 60 * 1000);
  return { url, opened: openBrowser ? openInBrowser(url) : false };
}

// ---------------------------------------------------------------- background jobs

const jobs = new Map();

function startJob(kind, label, fn, extra = {}) {
  const job = { id: crypto.randomUUID().slice(0, 8), kind, label, status: "running", sent: 0, total: 0, startedAt: Date.now(), ...extra };
  jobs.set(job.id, job);
  const onProgress = (sent, total) => {
    job.sent = sent;
    job.total = total;
  };
  fn(job, onProgress)
    .then((r) => {
      job.status = "done";
      job.result = r;
    })
    .catch((e) => {
      job.status = "failed";
      job.error = e.message || String(e);
      log(kind, e);
    })
    .finally(() => (job.finishedAt = Date.now()));
  return job;
}

function jobView(job) {
  const pct = job.total ? Math.round((job.sent / job.total) * 100) : 0;
  const v = {
    job_id: job.id,
    kind: job.kind,
    item: job.label,
    status: job.status,
    progress: job.total ? `${pct}% (${(job.sent / 1048576).toFixed(1)} of ${(job.total / 1048576).toFixed(1)} MB)` : undefined,
    elapsed_seconds: Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 1000),
  };
  if (job.result) v.result = job.result;
  if (job.error) v.error = job.error;
  const vid = job.result && (job.result.video || job.result);
  const privacy = vid && (vid.privacyStatus || vid.privacy);
  if (job.status === "done" && job.wantedPublic && privacy === "private") {
    v.note = "YouTube kept this upload private: until the Google Cloud project passes YouTube's API audit, API uploads are locked to private.";
  }
  return v;
}

async function waitJob(job, seconds) {
  const until = Date.now() + Math.max(0, Math.min(seconds, 55)) * 1000;
  while (job.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  return jobView(job);
}

// ---------------------------------------------------------------- shared schemas

const metaShape = {
  title: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  tags: z.array(z.string()).optional().describe("Keywords; total under 500 characters."),
  category_id: z.string().optional().describe("Default '1' Film & Animation. 24 Entertainment, 22 People & Blogs, 27 Education, 20 Gaming, 10 Music."),
  privacy_status: z.enum(["private", "unlisted", "public"]).optional().describe("Default private."),
  publish_at: z.string().optional().describe("Schedule: future ISO time, e.g. 2026-11-20T18:30:00+05:30 (keeps it private until then)."),
  made_for_kids: z.boolean().optional().describe("Default false."),
  contains_synthetic_media: z.boolean().optional().describe("Disclose realistic AI-generated/altered content."),
  default_language: z.string().optional().describe("e.g. 'hi' or 'en'."),
  notify_subscribers: z.boolean().optional().describe("Default true."),
  playlist_id: z.string().optional(),
};
const pickMeta = (a) => Object.fromEntries(Object.keys(metaShape).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const wantsPublic = (a) => !!a.publish_at || (a.privacy_status && a.privacy_status !== "private");

// ---------------------------------------------------------------- MCP server

const server = new McpServer({ name: "claude-youtube", version: VERSION });
const channelArg = z
  .string()
  .optional()
  .describe("Which YouTube channel to act on: its name, @handle, id or key from youtube_channels. Default: the main channel.");
const NO_CHANNEL = new Set(["youtube_auth_start", "youtube_auth_status", "youtube_channels", "youtube_cloud_key", "youtube_job_status", "youtube_drive_queue", "youtube_queue_to_drive", "youtube_upload_from_drive"]); // the Drive queue belongs to the main channel
const tool = (name, description, shape, handler, annotations = {}) => {
  const withChannel = NO_CHANNEL.has(name) ? shape : { ...shape, channel: channelArg };
  return server.registerTool(name, { description, inputSchema: withChannel, annotations }, async (args) => {
    try {
      const a = args || {};
      const key = NO_CHANNEL.has(name) ? MAIN : await resolveChannel(a.channel);
      return await ctx.run({ key }, () => handler(a));
    } catch (e) {
      log(name, e);
      return fail(e.message || String(e));
    }
  });
};

// --- connection

tool(
  "youtube_auth_start",
  "Start (or redo) the one-time Google sign-in for a YouTube channel. Without channel it signs in the main channel (YouTube + Google Drive). With channel set to a name (e.g. 'New Light') it adds or re-signs that extra channel, e.g. a brand channel of the same Google login: on Google's page pick that channel, then allow access. Returns a sign-in URL to open in a browser on this PC; the page then says 'YouTube connected'. Then call youtube_auth_status.",
  {
    channel: z.string().optional().describe("Name or key of the channel to sign in. Omit for the main channel."),
    open_in_default_browser: z.boolean().optional().describe("Also open the URL in the PC's default browser. Default false."),
  },
  async ({ channel, open_in_default_browser }) => {
    let key = MAIN;
    if (channel) key = await resolveChannel(channel).catch(() => slug(channel));
    const r = await startAuth(!!open_in_default_browser, key);
    return ok({
      channel_key: key,
      sign_in_url: r.url,
      opened_in_default_browser: r.opened,
      note: `Open on this PC (it returns to localhost:8765). Valid 15 minutes.${key === MAIN ? "" : " On Google's account page choose the channel itself (e.g. its brand account), not the personal account."}`,
    });
  },
  { openWorldHint: true }
);

tool(
  "youtube_auth_status",
  "Check which YouTube channels the connector is signed in to, and the state of the last sign-in.",
  {},
  async () => {
    const base = {
      client_file_found: !!(await findClientFile().catch(() => null)),
      sign_in_flow: auth.status,
      sign_in_channel_key: auth.key,
      ...(auth.channel ? { signed_in_channel: auth.channel } : {}),
      ...(auth.error ? { sign_in_error: auth.error } : {}),
    };
    const channels = [];
    for (const key of await knownKeys()) {
      const tok = await loadToken(key);
      if (!tok || !tok.refresh_token) {
        channels.push({ key, connected: false });
        continue;
      }
      try {
        const ch = await gFor(key).myChannel(true);
        await saveIndexEntry(key, ch);
        channels.push({ key, connected: true, id: ch.id, title: ch.snippet.title, handle: ch.snippet.customUrl, url: `https://www.youtube.com/channel/${ch.id}`, drive_queue: key === MAIN });
      } catch (e) {
        channels.push({ key, connected: false, error: e.message || String(e) });
      }
    }
    return ok({ connected: channels.some((c) => c.key === MAIN && c.connected), ...base, channels });
  },
  { readOnlyHint: true }
);

tool(
  "youtube_channels",
  "List the YouTube channels this connector can act on (key, title, handle, id). Pass any of these as the channel argument of other tools; without it they act on the main channel.",
  {},
  async () => {
    const idx = await loadIndex();
    const out = [];
    for (const key of await knownKeys()) {
      const tok = await loadToken(key);
      out.push({ key, signed_in: !!(tok && tok.refresh_token), default: key === MAIN, ...(idx[key] || {}) });
    }
    return ok(out);
  },
  { readOnlyHint: true }
);

tool(
  "youtube_cloud_key",
  `Prepare the one secret the cloud uploader (GitHub Actions in ${CLOUD_REPO}) needs, so uploads from Google Drive work while this PC is off. Copies it to this PC's clipboard (or, if no clipboard tool exists, saves it to ~/Desktop/claude-youtube-cloud-key.txt). The secret value is never shown to Claude. The owner then pastes it into GitHub → Settings → Secrets → Actions as YT_CLOUD_KEY.`,
  {},
  async () => {
    const client = await loadClient();
    const tok = await loadToken();
    if (!tok || !tok.refresh_token) throw new Error("Sign in first (youtube_auth_start).");
    const blob = Buffer.from(JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: tok.refresh_token })).toString("base64");
    const tryCopy = (cmd, args) =>
      new Promise((resolve) => {
        try {
          const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
          p.on("error", () => resolve(false));
          p.on("close", (code) => resolve(code === 0));
          p.stdin.end(blob);
        } catch {
          resolve(false);
        }
      });
    const candidates =
      process.platform === "darwin"
        ? [["pbcopy", []]]
        : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
    for (const [cmd, args] of candidates) {
      if (await tryCopy(cmd, args)) {
        return ok({ copied_to_clipboard: true, via: cmd, next: `Paste it as the value of a new repository secret named YT_CLOUD_KEY at https://github.com/${CLOUD_REPO}/settings/secrets/actions/new` });
      }
    }
    const file = path.join(os.homedir(), "Desktop", "claude-youtube-cloud-key.txt");
    await writePrivate(file, blob + "\n");
    return ok({
      copied_to_clipboard: false,
      saved_to_file: file,
      next: `Open that file, copy its single line, paste it as secret YT_CLOUD_KEY at https://github.com/${CLOUD_REPO}/settings/secrets/actions/new, then delete the file.`,
    });
  }
);

// --- channel & videos

tool(
  "youtube_channel_info",
  "Get the connected channel's details: name, handle, description, subscriber/view/video counts, uploads playlist and status.",
  {},
  async () => {
    const ch = await g.myChannel(true);
    return ok({
      id: ch.id,
      url: `https://www.youtube.com/channel/${ch.id}`,
      title: ch.snippet.title,
      handle: ch.snippet.customUrl,
      description: ch.snippet.description,
      country: ch.snippet.country,
      publishedAt: ch.snippet.publishedAt,
      statistics: ch.statistics,
      uploadsPlaylist: ch.contentDetails?.relatedPlaylists?.uploads,
      status: ch.status,
      keywords: ch.brandingSettings?.channel?.keywords,
    });
  },
  { readOnlyHint: true }
);

tool(
  "youtube_list_my_videos",
  "List the channel's own uploads (newest first) with title, privacy, schedule, duration and stats, including private and scheduled videos.",
  { max_results: z.number().int().min(1).max(200).optional().describe("Default 25."), page_token: z.string().optional() },
  async ({ max_results = 25, page_token }) => {
    const ch = await g.myChannel();
    const ids = [];
    let token = page_token;
    let next = null;
    while (ids.length < max_results) {
      const j = await g.yt("GET", "playlistItems", {
        part: "contentDetails",
        playlistId: ch.contentDetails.relatedPlaylists.uploads,
        maxResults: Math.min(50, max_results - ids.length),
        pageToken: token,
      });
      ids.push(...(j.items || []).map((i) => i.contentDetails.videoId));
      next = j.nextPageToken || null;
      if (!next) break;
      token = next;
    }
    const vids = await g.getVideos(ids);
    return ok({ videos: vids.map(slimVideo).map(({ description, ...rest }) => rest), next_page_token: next });
  },
  { readOnlyHint: true }
);

tool(
  "youtube_get_videos",
  "Get full details (title, description, tags, privacy, schedule, processing status, stats) for video IDs.",
  { video_ids: z.array(z.string()).min(1).max(50) },
  async ({ video_ids }) => ok((await g.getVideos(video_ids)).map(slimVideo)),
  { readOnlyHint: true }
);

tool(
  "youtube_upload_video",
  "Upload a video file from this PC to the channel with title, description, tags, category, privacy or scheduled time, optional custom thumbnail and playlist. Runs in the background; if not finished within wait_seconds it returns a job_id for youtube_job_status. Note: until the Google Cloud project passes YouTube's API audit, YouTube locks API uploads to private.",
  {
    file_path: z.string().describe("Video on this PC (~ allowed), e.g. ~/Videos/VideoStudio/film.mp4"),
    thumbnail_path: z.string().optional().describe("JPG/PNG on this PC, ≤2 MB, 1280x720 recommended."),
    ...metaShape,
    wait_seconds: z.number().min(0).max(55).optional().describe("Default 45."),
  },
  async (a) => {
    const job = startJob(
      "upload",
      a.title,
      async (_job, onProgress) => {
        const src = await g.localSource(a.file_path);
        let video;
        try {
          video = await g.uploadVideo({ size: src.size, mime: src.mime, getChunk: src.getChunk, meta: pickMeta(a), onProgress });
        } finally {
          await src.close();
        }
        const extras = {};
        if (a.thumbnail_path) {
          try {
            const f = expandHome(a.thumbnail_path);
            await g.setThumbnailBytes(video.id, await fsp.readFile(f), mimeFor(f));
            extras.thumbnail = "set";
          } catch (e) {
            extras.thumbnail = `failed: ${e.message}`;
          }
        }
        if (a.playlist_id) {
          try {
            await g.addToPlaylist(a.playlist_id, video.id);
            extras.playlist = "added";
          } catch (e) {
            extras.playlist = `failed: ${e.message}`;
          }
        }
        const [fresh] = await g.getVideos([video.id]).catch(() => [video]);
        return { video: slimVideo(fresh || video), ...extras };
      },
      { wantedPublic: wantsPublic(a) }
    );
    return ok(await waitJob(job, a.wait_seconds ?? 45));
  },
  { openWorldHint: true }
);

tool(
  "youtube_job_status",
  "Check a background job (upload, copy to Drive, upload from Drive): progress, then the result. Waits up to wait_seconds. Omit job_id to list all jobs this session.",
  { job_id: z.string().optional(), wait_seconds: z.number().min(0).max(55).optional() },
  async ({ job_id, wait_seconds = 30 }) => {
    if (!job_id) return ok([...jobs.values()].map(jobView));
    const job = jobs.get(job_id);
    if (!job) return fail(`No job ${job_id} (jobs are kept only while the Claude app is running).`);
    return ok(await waitJob(job, wait_seconds));
  },
  { readOnlyHint: true }
);

tool(
  "youtube_update_video",
  "Change an existing video's title, description, tags, category, privacy, scheduled time, made-for-kids or AI-content flag. Only the fields passed change.",
  {
    video_id: z.string(),
    title: z.string().min(1).max(100).optional(),
    description: z.string().max(5000).optional(),
    tags: z.array(z.string()).optional(),
    category_id: z.string().optional(),
    privacy_status: z.enum(["private", "unlisted", "public"]).optional(),
    publish_at: z.string().nullable().optional().describe("ISO time to schedule (video must be private), or null to clear."),
    made_for_kids: z.boolean().optional(),
    contains_synthetic_media: z.boolean().optional(),
    default_language: z.string().optional(),
  },
  async (a) => {
    const [v] = await g.getVideos([a.video_id]);
    if (!v) throw new Error(`Video ${a.video_id} not found on this channel.`);
    const s = v.snippet;
    const st = v.status;
    const snippet = {
      title: a.title ?? s.title,
      description: a.description ?? s.description ?? "",
      categoryId: a.category_id ?? s.categoryId,
      tags: a.tags ?? s.tags ?? [],
    };
    const lang = a.default_language ?? s.defaultLanguage;
    if (lang) snippet.defaultLanguage = lang;
    const audioLang = a.default_language ?? s.defaultAudioLanguage;
    if (audioLang) snippet.defaultAudioLanguage = audioLang;
    const status = {
      privacyStatus: a.privacy_status ?? st.privacyStatus,
      embeddable: st.embeddable,
      license: st.license,
      publicStatsViewable: st.publicStatsViewable,
      selfDeclaredMadeForKids: a.made_for_kids ?? st.selfDeclaredMadeForKids ?? st.madeForKids ?? false,
    };
    const synth = a.contains_synthetic_media ?? st.containsSyntheticMedia;
    if (synth !== undefined) status.containsSyntheticMedia = synth;
    const publishAt = a.publish_at === undefined ? st.publishAt : a.publish_at;
    if (publishAt) {
      status.publishAt = publishAt;
      status.privacyStatus = "private";
    }
    await g.yt("PUT", "videos", { part: "snippet,status" }, { id: a.video_id, snippet, status });
    const [fresh] = await g.getVideos([a.video_id]);
    return ok(slimVideo(fresh));
  }
);

tool(
  "youtube_set_thumbnail",
  "Set a custom thumbnail from a JPG/PNG on this PC (≤2 MB, 1280x720 recommended). The channel must be phone-verified for custom thumbnails.",
  { video_id: z.string(), image_path: z.string() },
  async ({ video_id, image_path }) => {
    const f = expandHome(image_path);
    return ok(await g.setThumbnailBytes(video_id, await fsp.readFile(f), mimeFor(f)));
  }
);

tool(
  "youtube_delete_video",
  "Permanently delete a video from the channel. Cannot be undone — only when the owner clearly asked to delete this video.",
  { video_id: z.string(), confirm_title: z.string().describe("The video's exact current title, as a safety check.") },
  async ({ video_id, confirm_title }) => {
    const [v] = await g.getVideos([video_id]);
    if (!v) throw new Error(`Video ${video_id} not found.`);
    if (v.snippet.title.trim() !== confirm_title.trim()) throw new Error(`Title mismatch: the video is titled "${v.snippet.title}". Nothing was deleted.`);
    await g.yt("DELETE", "videos", { id: video_id });
    return ok({ deleted: video_id, title: v.snippet.title });
  },
  { destructiveHint: true }
);

tool(
  "youtube_video_categories",
  "List assignable YouTube video categories (IDs and names) for a region.",
  { region_code: z.string().length(2).optional().describe("Default IN.") },
  async ({ region_code = "IN" }) => {
    const j = await g.yt("GET", "videoCategories", { part: "snippet", regionCode: region_code, hl: "en" });
    return ok((j.items || []).filter((c) => c.snippet.assignable).map((c) => ({ id: c.id, title: c.snippet.title })));
  },
  { readOnlyHint: true }
);

// --- playlists

tool(
  "youtube_list_playlists",
  "List the channel's playlists.",
  { max_results: z.number().int().min(1).max(50).optional() },
  async ({ max_results = 50 }) => {
    const j = await g.yt("GET", "playlists", { part: "snippet,status,contentDetails", mine: "true", maxResults: max_results });
    return ok((j.items || []).map((p) => ({ id: p.id, title: p.snippet.title, description: p.snippet.description, privacyStatus: p.status.privacyStatus, itemCount: p.contentDetails.itemCount })));
  },
  { readOnlyHint: true }
);

tool(
  "youtube_create_playlist",
  "Create a playlist on the channel.",
  { title: z.string().min(1).max(150), description: z.string().max(5000).optional(), privacy_status: z.enum(["private", "unlisted", "public"]).optional().describe("Default public.") },
  async ({ title, description, privacy_status = "public" }) => {
    const p = await g.yt("POST", "playlists", { part: "snippet,status" }, { snippet: { title, description: description || "" }, status: { privacyStatus: privacy_status } });
    return ok({ id: p.id, title: p.snippet.title, privacyStatus: p.status.privacyStatus, url: `https://www.youtube.com/playlist?list=${p.id}` });
  }
);

tool(
  "youtube_add_to_playlist",
  "Add a video to a playlist.",
  { playlist_id: z.string(), video_id: z.string(), position: z.number().int().min(0).optional() },
  async ({ playlist_id, video_id, position }) => {
    const r = await g.addToPlaylist(playlist_id, video_id, position);
    return ok({ playlist_item_id: r.id, playlist_id, video_id });
  }
);

// --- comments

tool(
  "youtube_list_comments",
  "Read comment threads (with replies) on one video, or across the whole channel if video_id is omitted.",
  { video_id: z.string().optional(), max_results: z.number().int().min(1).max(100).optional(), order: z.enum(["time", "relevance"]).optional(), page_token: z.string().optional() },
  async ({ video_id, max_results = 20, order = "time", page_token }) => {
    const params = { part: "snippet,replies", maxResults: max_results, order, textFormat: "plainText", pageToken: page_token };
    if (video_id) params.videoId = video_id;
    else params.allThreadsRelatedToChannelId = (await g.myChannel()).id;
    const j = await g.yt("GET", "commentThreads", params);
    const c = (x) => ({ id: x.id, author: x.snippet.authorDisplayName, text: x.snippet.textDisplay, likes: x.snippet.likeCount, publishedAt: x.snippet.publishedAt });
    return ok({
      threads: (j.items || []).map((t) => ({
        thread_id: t.id,
        video_id: t.snippet.videoId,
        top: c(t.snippet.topLevelComment),
        reply_count: t.snippet.totalReplyCount,
        replies: (t.replies?.comments || []).map(c),
      })),
      next_page_token: j.nextPageToken || null,
    });
  },
  { readOnlyHint: true }
);

tool(
  "youtube_reply_to_comment",
  "Post a reply, as the channel, to a comment (use the top comment's id).",
  { parent_comment_id: z.string(), text: z.string().min(1).max(10000) },
  async ({ parent_comment_id, text }) => {
    const r = await g.yt("POST", "comments", { part: "snippet" }, { snippet: { parentId: parent_comment_id, textOriginal: text } });
    return ok({ comment_id: r.id, text: r.snippet.textOriginal });
  },
  { openWorldHint: true }
);

tool(
  "youtube_post_comment",
  "Post a new top-level comment, as the channel, on a video.",
  { video_id: z.string(), text: z.string().min(1).max(10000) },
  async ({ video_id, text }) => {
    const ch = await g.myChannel();
    const r = await g.yt("POST", "commentThreads", { part: "snippet" }, { snippet: { channelId: ch.id, videoId: video_id, topLevelComment: { snippet: { textOriginal: text } } } });
    return ok({ thread_id: r.id, text: r.snippet.topLevelComment.snippet.textOriginal });
  },
  { openWorldHint: true }
);

// --- research & analytics

tool(
  "youtube_search",
  "Search public YouTube (videos, channels, playlists) for topic and competitor research. Uses a separate small daily quota (about 100 searches/day).",
  {
    query: z.string().min(1),
    type: z.enum(["video", "channel", "playlist"]).optional(),
    max_results: z.number().int().min(1).max(50).optional(),
    order: z.enum(["relevance", "date", "viewCount", "rating"]).optional(),
    published_after: z.string().optional(),
    region_code: z.string().length(2).optional(),
    video_duration: z.enum(["any", "short", "medium", "long"]).optional(),
  },
  async (a) => {
    const type = a.type || "video";
    const j = await g.yt("GET", "search", {
      part: "snippet",
      q: a.query,
      type,
      maxResults: a.max_results || 15,
      order: a.order || "relevance",
      publishedAfter: a.published_after,
      regionCode: a.region_code,
      videoDuration: type === "video" ? a.video_duration : undefined,
    });
    const items = j.items || [];
    const stats = new Map((await g.getVideos(items.filter((i) => i.id.videoId).map((i) => i.id.videoId)).catch(() => [])).map((v) => [v.id, v]));
    return ok(
      items.map((i) => {
        const v = stats.get(i.id.videoId);
        return {
          kind: i.id.kind.replace("youtube#", ""),
          id: i.id.videoId || i.id.channelId || i.id.playlistId,
          title: i.snippet.title,
          channel: i.snippet.channelTitle,
          publishedAt: i.snippet.publishedAt,
          ...(v ? { views: v.statistics.viewCount, likes: v.statistics.likeCount, comments: v.statistics.commentCount, duration: v.contentDetails.duration } : {}),
        };
      })
    );
  },
  { readOnlyHint: true, openWorldHint: true }
);

tool(
  "youtube_analytics",
  "Query YouTube Analytics for the channel. Examples: metrics='views,estimatedMinutesWatched,averageViewDuration,subscribersGained', dimensions='day' | 'video' (sort='-views', max_results=10) | 'insightTrafficSourceType' | 'country'; filters='video==VIDEO_ID'.",
  {
    start_date: z.string().describe("YYYY-MM-DD"),
    end_date: z.string().describe("YYYY-MM-DD"),
    metrics: z.string(),
    dimensions: z.string().optional(),
    filters: z.string().optional(),
    sort: z.string().optional(),
    max_results: z.number().int().min(1).max(200).optional(),
  },
  async (a) => {
    const j = await g.analytics({ startDate: a.start_date, endDate: a.end_date, metrics: a.metrics, dimensions: a.dimensions, filters: a.filters, sort: a.sort, maxResults: a.max_results });
    const cols = (j.columnHeaders || []).map((c) => c.name);
    return ok({ columns: cols, rows: (j.rows || []).map((r) => Object.fromEntries(r.map((v, i) => [cols[i], v]))) });
  },
  { readOnlyHint: true }
);

// --- Google Drive queue (for uploads while the PC is off)

tool(
  "youtube_queue_to_drive",
  `Copy a finished video (and optional thumbnail) from this PC into the Google Drive folder "${QUEUE_FOLDER_NAME}" together with its YouTube details, as a queued upload. The cloud uploader (GitHub Actions) — or youtube_upload_from_drive on this PC — later uploads it to YouTube and then permanently deletes the Drive copies to free space. Set upload_after to hold it until a time. Runs in the background; check with youtube_job_status.`,
  {
    file_path: z.string(),
    thumbnail_path: z.string().optional(),
    ...metaShape,
    upload_after: z.string().optional().describe("ISO time; the uploader waits until then."),
    delete_from_drive_after_upload: z.boolean().optional().describe("Default true."),
    wait_seconds: z.number().min(0).max(55).optional(),
  },
  async (a) => {
    const job = startJob("copy-to-drive", a.title, async (_job, onProgress) => {
      const folder = await g.queueFolder(true);
      const base = path.basename(expandHome(a.file_path));
      const video = await g.driveUploadLocal(a.file_path, folder.id, base, onProgress);
      let thumb = null;
      if (a.thumbnail_path) thumb = await g.driveUploadLocal(a.thumbnail_path, folder.id, path.basename(expandHome(a.thumbnail_path)));
      const jobDoc = {
        ...pickMeta(a),
        video_file_id: video.id,
        video_file_name: video.name,
        ...(thumb ? { thumbnail_file_id: thumb.id, thumbnail_file_name: thumb.name } : {}),
        ...(a.upload_after ? { upload_after: a.upload_after } : {}),
        delete_from_drive_after_upload: a.delete_from_drive_after_upload !== false,
        status: "queued",
        attempts: 0,
        source: "pc",
        created_at: new Date().toISOString(),
      };
      const name = base.replace(/\.[^.]+$/, "") + JOB_SUFFIX;
      const jf = await g.driveCreateText(name, folder.id, JSON.stringify(jobDoc, null, 2));
      return { queued: true, job_file_id: jf.id, job_file_name: name, folder_id: folder.id, video_drive_id: video.id, size_mb: +(Number(video.size || 0) / 1048576).toFixed(1) };
    });
    return ok(await waitJob(job, a.wait_seconds ?? 20));
  }
);

tool(
  "youtube_drive_queue",
  `List what is waiting in the Google Drive folder "${QUEUE_FOLDER_NAME}": each queued upload's title, status, attempts and last error, plus loose files.`,
  {},
  async () => {
    const q = await g.listQueue();
    if (!q.folder) return ok({ folder: null, note: `No "${QUEUE_FOLDER_NAME}" folder yet; it is created on the first youtube_queue_to_drive.` });
    return ok({
      folder_id: q.folder.id,
      jobs: q.jobs.map((j) => ({
        job_file_id: j.job_file_id,
        title: j.title,
        status: j.status,
        attempts: j.attempts,
        upload_after: j.upload_after,
        last_error: j.last_error,
        youtube_video_id: j.youtube_video_id,
        video_file_name: j.video_file_name,
      })),
      other_files: q.other_files,
    });
  },
  { readOnlyHint: true }
);

tool(
  "youtube_upload_from_drive",
  "Upload queued Drive videos to YouTube from this PC now (instead of waiting for the cloud uploader), then permanently delete their Drive copies. Pass job_file_id for one job, or omit it to process every ready job in the queue.",
  { job_file_id: z.string().optional(), force: z.boolean().optional().describe("Ignore upload_after / failed status."), wait_seconds: z.number().min(0).max(55).optional() },
  async ({ job_file_id, force, wait_seconds }) => {
    const job = startJob("upload-from-drive", job_file_id || "whole queue", async (_job, onProgress) => {
      const ids = job_file_id ? [job_file_id] : (await g.listQueue()).jobs.map((j) => j.job_file_id);
      const results = [];
      for (const id of ids) {
        try {
          results.push(await g.processJob(id, { runner: "pc", force: !!force, onProgress }));
        } catch (e) {
          results.push({ job_file_id: id, error: e.message });
        }
      }
      return { processed: results.length, results };
    });
    return ok(await waitJob(job, wait_seconds ?? 45));
  },
  { openWorldHint: true }
);

// ---------------------------------------------------------------- start

server
  .connect(new StdioServerTransport())
  .then(() => log(`v${VERSION} ready; config in ${CONFIG_DIR}`))
  .catch((e) => {
    log("failed to start", e);
    process.exit(1);
  });
