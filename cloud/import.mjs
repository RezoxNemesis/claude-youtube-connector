// Import: rebuilds a video sent in pieces on a temporary "transfer/…" branch, checks it,
// and puts it (plus thumbnail and YouTube details) into the Google Drive queue folder.
// Used when the owner's PC is off but Claude still holds the finished file.
//
// IMPORT_DIR contains: manifest.json { video_name, sha256, parts:[...], thumbnail?, job:{...} },
// the parts, and the thumbnail file. Writes job_file_id to $GITHUB_OUTPUT.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createGoogle, refreshTokenAuth, JOB_SUFFIX } from "../src/core.mjs";

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
  const dir = process.env.IMPORT_DIR;
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const out = path.join("/tmp", m.video_name);
  const w = fs.openSync(out, "w");
  const hash = crypto.createHash("sha256");
  for (const p of m.parts) {
    const buf = fs.readFileSync(path.join(dir, p));
    fs.writeSync(w, buf);
    hash.update(buf);
  }
  fs.closeSync(w);
  const sha = hash.digest("hex");
  if (sha !== m.sha256) throw new Error(`Rebuilt file does not match (sha256 ${sha} ≠ ${m.sha256}).`);
  log(`rebuilt ${m.video_name}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MB, checksum OK`);

  const g = createGoogle(refreshTokenAuth(credentials()), log);
  const folder = await g.queueFolder(true);
  let last = -1;
  const video = await g.driveUploadLocal(out, folder.id, m.video_name, (s, t) => {
    const pct = Math.floor((s / t) * 4) * 25;
    if (pct !== last) log(`  to Drive: ${(last = pct)}%`);
  });
  log(`in Drive queue: ${video.name}`);
  let thumb = null;
  if (m.thumbnail) {
    thumb = await g.driveUploadLocal(path.join(dir, m.thumbnail), folder.id, m.thumbnail);
    log(`thumbnail in Drive: ${thumb.name}`);
  }
  const job = {
    ...m.job,
    video_file_id: video.id,
    video_file_name: video.name,
    ...(thumb ? { thumbnail_file_id: thumb.id, thumbnail_file_name: thumb.name } : {}),
    delete_from_drive_after_upload: true,
    status: "queued",
    attempts: 0,
    source: "transfer",
    created_at: new Date().toISOString(),
  };
  const name = m.video_name.replace(/\.[^.]+$/, "") + JOB_SUFFIX;
  const jf = await g.driveCreateText(name, folder.id, JSON.stringify(job, null, 2));
  log(`queued job ${name}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `job_file_id=${jf.id}\n`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
