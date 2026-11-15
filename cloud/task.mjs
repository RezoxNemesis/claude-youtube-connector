// Cloud task runner: applies a YouTube task file from this repo (subtitles, translated titles and
// descriptions, privacy changes) using the YT_CLOUD_KEY secret. Works while the owner's PC is off.
//
// Task file (JSON), path given in TASK_FILE:
// {
//   "video_id": "abc123",
//   "captions": [ { "language": "hi", "name": "हिन्दी", "file": "tasks/x/hi.srt" } ],
//   "default_language": "en",
//   "localizations": { "hi": { "title": "…", "description": "…" } },
//   "privacy_status": "public",                    // optional
//   "publish_after_processed_seconds": 60          // optional: wait until processed, then this many seconds, then go public
// }

import fs from "node:fs";
import { createGoogle, refreshTokenAuth } from "../src/core.mjs";
import { runTask } from "./tasklib.mjs";

const log = (...a) => console.log(...a);

function credentials() {
  const raw = (process.env.YT_CLOUD_KEY || "").replace(/\s+/g, "");
  for (const text of [raw, Buffer.from(raw, "base64").toString("utf8")]) {
    try {
      const j = JSON.parse(text);
      if (j.client_id && j.client_secret && j.refresh_token) return j;
    } catch {}
  }
  throw new Error("YT_CLOUD_KEY secret is missing or not the cloud key.");
}

async function main() {
  const file = process.env.TASK_FILE;
  if (!file) throw new Error("TASK_FILE is required.");
  const task = JSON.parse(fs.readFileSync(file, "utf8"));
  const id = task.video_id;
  const g = createGoogle(refreshTokenAuth(credentials()), log);
  const lines = await runTask(g, id, task, log);
  const caps = await g.listCaptions(id);
  const summary = [`## YouTube task for https://youtu.be/${id}`, "", ...lines.map((l) => `- ${l}`), "", `Caption tracks: ${caps.map((c) => `${c.language}${c.trackKind === "asr" ? " (auto)" : ""}`).join(", ") || "none"}`];
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
