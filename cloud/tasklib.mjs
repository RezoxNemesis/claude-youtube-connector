// Shared "task" steps for the cloud jobs: subtitles, translations, publishing and a comment.
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// task: { captions:[{language,name,file}], default_language, localizations, privacy_status,
//         publish_after_processed_seconds, comment }
export async function runTask(g, id, task, log = console.log) {
  const summary = [];

  for (const c of task.captions || []) {
    const text = fs.readFileSync(path.resolve(c.file), "utf8");
    const r = await g.uploadCaption(id, c.language, c.name, text);
    log(`subtitles ${c.language}: ${r.replaced ? "replaced" : "added"}`);
    summary.push(`Subtitles ${c.language}: ${r.replaced ? "replaced" : "added"}`);
  }

  if (task.localizations) {
    const r = await g.setLocalizations(id, task.default_language, task.localizations);
    log(`translated title/description: ${r.languages.join(", ")}`);
    summary.push(`Translations: ${r.languages.join(", ")}`);
  }

  let privacy = task.privacy_status;
  if (task.publish_after_processed_seconds !== undefined && task.publish_after_processed_seconds !== null) {
    let p;
    for (let i = 0; i < 180; i++) {
      p = await g.processing(id);
      if (p.processingStatus === "succeeded" || p.uploadStatus === "processed") break;
      if (["failed", "rejected"].includes(p.processingStatus) || ["failed", "rejected", "deleted"].includes(p.uploadStatus)) {
        throw new Error(`YouTube processing ${p.processingStatus || p.uploadStatus}`);
      }
      await sleep(20_000);
    }
    log(`processing finished; going public in ${task.publish_after_processed_seconds}s`);
    await sleep(task.publish_after_processed_seconds * 1000);
    privacy = "public";
  }

  if (privacy) {
    const [v] = await g.getVideos([id]);
    await g.yt("PUT", "videos", { part: "status" }, {
      id,
      status: {
        privacyStatus: privacy,
        embeddable: v.status.embeddable,
        license: v.status.license,
        publicStatsViewable: v.status.publicStatsViewable,
        selfDeclaredMadeForKids: v.status.selfDeclaredMadeForKids ?? v.status.madeForKids ?? false,
      },
    });
    // YouTube can take a few seconds to show the change.
    let now = "";
    for (let i = 0; i < 6; i++) {
      now = (await g.processing(id)).privacyStatus;
      if (now === privacy) break;
      await sleep(5000);
    }
    log(`privacy: ${now}`);
    summary.push(`Privacy: ${now}`);
  }

  if (task.comment) {
    const ch = await g.myChannel();
    let done = false;
    for (let i = 0; i < 6 && !done; i++) {
      try {
        await g.yt("POST", "commentThreads", { part: "snippet" }, {
          snippet: { channelId: ch.id, videoId: id, topLevelComment: { snippet: { textOriginal: task.comment } } },
        });
        done = true;
      } catch (e) {
        if (i === 5) throw e;
        await sleep(10_000);
      }
    }
    log("comment posted");
    summary.push("Comment posted (pin it from the YouTube app or Studio)");
  }

  return summary;
}
