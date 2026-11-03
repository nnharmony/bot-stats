import fs from "node:fs/promises";

const bots = JSON.parse(await fs.readFile("bots.json", "utf8"));
const historyPath = "data/history.json";

const BATCH_SIZE = 5;
const WAIT_MS = 60000;
const MODE = process.env.TRACK_MODE || "normal";

if (!["normal", "retry"].includes(MODE)) {
  throw new Error(`Unknown mode: ${MODE}`);
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
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
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

let history;

try {
  history = JSON.parse(await fs.readFile(historyPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  history = { generated_at: null, snapshots: [] };
}

history.snapshots ||= [];

const lastSnapshot = history.snapshots.at(-1);

if (MODE === "retry" && !lastSnapshot) {
  throw new Error("No previous snapshot to retry");
}

// We assume bots.json lists oldest characters first.
// Reverse the processing order without changing bots.json.
const newestFirst = [...bots].reverse();

const previousByCid = new Map();

for (const snapshot of [...history.snapshots].reverse()) {
  for (const bot of snapshot.bots || []) {
    if (!previousByCid.has(bot.cid) && !bot.stale) {
      previousByCid.set(bot.cid, bot);
    }
  }
}

let pendingBots;

if (MODE === "retry") {
  const failedCids = new Set(
    (lastSnapshot.bots || [])
      .filter(bot => bot.stale)
      .map(bot => bot.cid)
  );

  pendingBots = newestFirst.filter(bot => failedCids.has(bot.cid));

  console.log(`Retry mode: ${pendingBots.length} failed bots`);
} else {
  pendingBots = newestFirst;
  console.log(`Normal mode: ${pendingBots.length} bots`);
}

const resultsByCid = new Map(
  MODE === "retry"
    ? (lastSnapshot.bots || []).map(bot => [bot.cid, bot])
    : []
);

for (let start = 0; start < pendingBots.length; start += BATCH_SIZE) {
  const batch = pendingBots.slice(start, start + BATCH_SIZE);

  console.log(
    `\nBatch ${Math.floor(start / BATCH_SIZE) + 1}: ${batch.length} bots`
  );

  for (const bot of batch) {
    try {
      const stat = await fetchStats(bot);

      resultsByCid.set(bot.cid, stat);

      console.log(
        `✓ ${bot.cid} ${bot.name}: ${stat.messages} / ${stat.collectors}`
      );
    } catch (error) {
      const previous = previousByCid.get(bot.cid);

      resultsByCid.set(bot.cid, {
        cid: bot.cid,
        name: bot.name,
        url: bot.url,
        messages: previous?.messages ?? null,
        collectors: previous?.collectors ?? null,
        stale: true,
        error: String(error.message || error)
      });

      console.error(
        `✗ ${bot.cid} ${bot.name}: ${error.message || error}`
      );
    }

    // Wait between requests, including between batches.
    const processed = start + batch.indexOf(bot) + 1;

    if (processed < pendingBots.length) {
      await new Promise(resolve => setTimeout(resolve, WAIT_MS));
    }
  }
}

// Keep the original bot order inside the snapshot.
// Only the fetching order changes.
const results = bots.map(bot => resultsByCid.get(bot.cid)).filter(Boolean);

if (MODE === "retry") {
  // Update the existing snapshot instead of creating another one.
  lastSnapshot.bots = results;
} else {
  const snapshot = {
    timestamp: new Date().toISOString(),
    bots: results
  };

  history.snapshots.push(snapshot);
  history.generated_at = snapshot.timestamp;
}

// No 800-snapshot limit: retain the entire history.
await fs.mkdir("data", { recursive: true });

await fs.writeFile(
  historyPath,
  JSON.stringify(history, null, 2)
);

const failed = results.filter(bot => bot.stale).length;

console.log(`\nFinished: ${results.length - failed} successful, ${failed} stale.`);
