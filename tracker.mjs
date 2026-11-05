import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

const bots = JSON.parse(await fs.readFile("bots.json", "utf8"));

const historyPath = "data/history.json";
const progressPath = "data/update-progress.json";

const BATCH_SIZE = 5;
const WAIT_MS = 60000;
const MODE = process.env.TRACK_MODE || "normal";

if (!["normal", "retry"].includes(MODE)) {
  throw new Error(`Unknown mode: ${MODE}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function git(...args) {
  execFileSync("git", args, { stdio: "inherit" });
}

async function writeJSON(path, value) {
  const temporary = `${path}.tmp`;

  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, path);
}

function findStatsObject(value) {
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStatsObject(item);
      if (found) return found;
    }
    return null;
  }

  if (Array.isArray(value.interactionStatistic)) return value;

  for (const child of Object.values(value)) {
    const found = findStatsObject(child);
    if (found) return found;
  }

  return null;
}

async function fetchStats(bot) {
  const response = await fetch(bot.url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "accept-language": "en-US,en;q=0.9"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  const blocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const data = findStatsObject(parsed);

      if (!data) continue;

      const stats = Object.fromEntries(
        (data.interactionStatistic || []).map(item => [
          String(item.interactionType || "").split("/").pop(),
          Number(item.userInteractionCount)
        ])
      );

      if (Number.isFinite(stats.WriteAction)) {
        return {
          cid: bot.cid,
          name: bot.name,
          url: bot.url,
          messages: stats.WriteAction,
          collectors: Number.isFinite(stats.FollowAction)
            ? stats.FollowAction
            : null
        };
      }
    } catch {}
  }

  throw new Error("No interaction statistics found");
}

await fs.mkdir("data", { recursive: true });

let history;

try {
  history = JSON.parse(await fs.readFile(historyPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  history = { generated_at: null, snapshots: [] };
}

history.snapshots ||= [];

const lastSnapshot = history.snapshots.at(-1);
const newestFirst = [...bots].reverse();

const previousByCid = new Map();

for (const snapshot of [...history.snapshots].reverse()) {
  for (const bot of snapshot.bots || []) {
    if (!previousByCid.has(bot.cid) && !bot.stale) {
      previousByCid.set(bot.cid, bot);
    }
  }
}

let progress;

try {
  progress = JSON.parse(await fs.readFile(progressPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (progress) {
  if (progress.mode !== MODE) {
    throw new Error(
      `Unfinished ${progress.mode} update exists. Resume that mode first.`
    );
  }

  console.log("Resuming unfinished update.");
} else {
  if (MODE === "retry" && !lastSnapshot) {
    throw new Error("No previous snapshot to retry");
  }

  let selectedBots = newestFirst;

  if (MODE === "retry") {
    const failedCids = new Set(
      (lastSnapshot.bots || [])
        .filter(bot => bot.stale)
        .map(bot => bot.cid)
    );

    selectedBots = newestFirst.filter(bot => failedCids.has(bot.cid));
  }

  progress = {
    mode: MODE,
    started_at: new Date().toISOString(),
    snapshot_timestamp:
      MODE === "retry" ? lastSnapshot.timestamp : null,
    bot_ids: selectedBots.map(bot => bot.cid),
    results: {}
  };

  console.log(`Starting ${MODE} update: ${selectedBots.length} bots.`);
}

if (
  MODE === "retry" &&
  lastSnapshot?.timestamp !== progress.snapshot_timestamp
) {
  throw new Error(
    "The latest snapshot changed since this retry started."
  );
}

const botsByCid = new Map(bots.map(bot => [bot.cid, bot]));

for (const cid of progress.bot_ids) {
  if (!botsByCid.has(cid)) {
    throw new Error(`Bot ${cid} is missing from bots.json`);
  }
}

const pendingBots = progress.bot_ids
  .filter(cid => !(cid in progress.results))
  .map(cid => botsByCid.get(cid));

console.log(`${pendingBots.length} bots remaining.`);

async function saveCheckpoint() {
  await writeJSON(progressPath, progress);

  git("add", progressPath);
  git("commit", "-m", "Save character update progress");
  git("push");

  console.log("✓ Checkpoint saved to GitHub.");
}

for (let start = 0; start < pendingBots.length; start += BATCH_SIZE) {
  const batch = pendingBots.slice(start, start + BATCH_SIZE);

  console.log(
    `\nBatch ${Math.floor(start / BATCH_SIZE) + 1}: ${batch.length} bots`
  );

  for (let index = 0; index < batch.length; index++) {
    const bot = batch[index];

    try {
      const stat = await fetchStats(bot);

      progress.results[bot.cid] = stat;

      console.log(
        `✓ ${bot.cid} ${bot.name}: ${stat.messages} / ${stat.collectors}`
      );
    } catch (error) {
      const previous = previousByCid.get(bot.cid);

      progress.results[bot.cid] = {
        cid: bot.cid,
        name: bot.name,
        url: bot.url,
        messages: previous?.messages ?? null,
        collectors: previous?.collectors ?? null,
        stale: true,
        error: String(error.message || error)
      };

      console.error(
        `✗ ${bot.cid} ${bot.name}: ${error.message || error}`
      );
    }

    const isLastRequest =
      start + index + 1 === pendingBots.length;

    if (!isLastRequest) {
      await sleep(WAIT_MS);
    }
  }

  await saveCheckpoint();
}

let results;

if (MODE === "retry") {
  const resultsByCid = new Map(
    (lastSnapshot.bots || []).map(bot => [bot.cid, bot])
  );

  for (const [cid, stat] of Object.entries(progress.results)) {
    resultsByCid.set(cid, stat);
  }

  results = bots
    .map(bot => resultsByCid.get(bot.cid))
    .filter(Boolean);

  lastSnapshot.bots = results;
} else {
  const resultsByCid = new Map(
    Object.entries(progress.results)
  );

  results = bots.map(bot => {
    const result = resultsByCid.get(bot.cid);

    if (!result) {
      throw new Error(`Missing result for ${bot.cid}`);
    }

    return result;
  });

  const snapshot = {
    timestamp: progress.started_at,
    bots: results
  };

  history.snapshots.push(snapshot);
  history.generated_at = snapshot.timestamp;
}

// Preserve all historical snapshots.
await writeJSON(historyPath, history);

// Remove the completed checkpoint locally.
// The workflow will commit this deletion.
await fs.unlink(progressPath);

const failed = results.filter(bot => bot.stale).length;

console.log(
  `\nFinished: ${results.length - failed} successful, ${failed} stale.`
);
