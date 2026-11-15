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
import path from "node:path";
import { createGoogle, refreshTokenAuth } from "../src/core.mjs";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const summary = [`## YouTube task for https://youtu.be/${id}`, ""];

  for (const c of task.captions || []) {
    const text = fs.readFileSync(path.resolve(c.file), "utf8");
    const r = await g.uploadCaption(id, c.language, c.name, text);
    log(`captions ${c.language} (${c.name}): ${r.replaced ? "replaced" : "added"}`);
    summary.push(`- Subtitles ${c.language}: ${r.replaced ? "replaced" : "added"}`);
  }

  if (task.localizations) {
    const r = await g.setLocalizations(id, task.default_language, task.localizations);
    log(`translations: ${r.languages.join(", ")} (default ${r.default_language})`);
    summary.push(`- Translated title/description: ${r.languages.join(", ")}`);
  }

  if (task.publish_after_processed_seconds !== undefined) {
    for (let i = 0; i < 180; i++) {
      const p = await g.processing(id);
      if (p.processingStatus === "succeeded" || p.uploadStatus === "processed") break;
      if (p.processingStatus === "failed" || p.uploadStatus === "failed" || p.uploadStatus === "rejected") throw new Error(`Processing ${p.processingStatus || p.uploadStatus}`);
      await sleep(20_000);
    }
    log(`processed; going public in ${task.publish_after_processed_seconds}s`);
    await sleep(task.publish_after_processed_seconds * 1000);
    task.privacy_status = "public";
  }

  if (task.privacy_status) {
    const [v] = await g.getVideos([id]);
    await g.yt("PUT", "videos", { part: "status" }, {
      id,
      status: {
        privacyStatus: task.privacy_status,
        embeddable: v.status.embeddable,
        license: v.status.license,
        publicStatsViewable: v.status.publicStatsViewable,
        selfDeclaredMadeForKids: v.status.selfDeclaredMadeForKids ?? v.status.madeForKids ?? false,
      },
    });
    const after = await g.processing(id);
    log(`privacy now: ${after.privacyStatus}`);
    summary.push(`- Privacy: ${after.privacyStatus}`);
  }

  const caps = await g.listCaptions(id);
  summary.push("", `Caption tracks: ${caps.map((c) => `${c.language}${c.trackKind === "asr" ? " (auto)" : ""}`).join(", ") || "none"}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
