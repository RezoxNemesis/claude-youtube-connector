// Cloud uploader: runs on GitHub Actions while the owner's PC is off.
// Finds queued jobs in the Google Drive folder "Claude YouTube Queue", uploads each video to
// YouTube with its details and thumbnail, then permanently deletes the Drive copies.
//
// Needs one repository secret, YT_CLOUD_KEY: base64 of {client_id, client_secret, refresh_token},
// produced on the PC by the connector tool youtube_cloud_key.

import fs from "node:fs";
import { createGoogle, refreshTokenAuth } from "../src/core.mjs";

const log = (...a) => console.log(...a);

function credentials() {
  const raw = process.env.YT_CLOUD_KEY;
  if (!raw) throw new Error("Secret YT_CLOUD_KEY is not set (Settings → Secrets and variables → Actions).");
  const j = JSON.parse(Buffer.from(raw.trim(), "base64").toString("utf8"));
  if (!j.client_id || !j.client_secret || !j.refresh_token) throw new Error("YT_CLOUD_KEY is incomplete.");
  return j;
}

function summary(lines) {
  const f = process.env.GITHUB_STEP_SUMMARY;
  if (f) fs.appendFileSync(f, lines.join("\n") + "\n");
}

async function main() {
  const g = createGoogle(refreshTokenAuth(credentials()), (m) => log(m));
  const only = (process.env.JOB_FILE_ID || "").trim();
  const force = process.env.FORCE === "true";

  let ids;
  if (only) ids = [only];
  else {
    const q = await g.listQueue();
    if (!q.folder) {
      log("No queue folder in Drive yet. Nothing to do.");
      summary(["Queue folder not found — nothing to upload."]);
      return;
    }
    ids = q.jobs.map((j) => j.job_file_id);
  }
  log(`${ids.length} job(s) in the queue`);

  const rows = ["| Job | Result |", "|---|---|"];
  let failures = 0;
  for (const id of ids) {
    let lastPct = -1;
    const onProgress = (sent, total) => {
      const pct = Math.floor((sent / total) * 10) * 10;
      if (pct !== lastPct) {
        lastPct = pct;
        log(`  ${pct}%`);
      }
    };
    try {
      const r = await g.processJob(id, { runner: "github-actions", force, onProgress });
      if (r.skipped) {
        log(`skip: ${r.skipped}`);
        rows.push(`| ${id.slice(0, 8)}… | skipped: ${r.skipped} |`);
      } else {
        log(`uploaded → ${r.url} (${r.privacy}); removed ${r.deleted_from_drive.length} file(s) from Drive`);
        rows.push(`| ${id.slice(0, 8)}… | uploaded ${r.url} (${r.privacy}) |`);
      }
    } catch (e) {
      failures++;
      log(`failed: ${e.message}`);
      rows.push(`| ${id.slice(0, 8)}… | failed: ${String(e.message).replace(/\|/g, "/").slice(0, 200)} |`);
    }
  }
  summary(["## Claude YouTube uploads", "", ...rows]);
  if (failures) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
