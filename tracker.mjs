import fs from "node:fs/promises";

const bots = JSON.parse(await fs.readFile("bots.json", "utf8"));
const historyPath = "data/history.json";

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
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

  const html = await response.text();
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      const data = findStatsObject(parsed);
      if (!data) continue;
      const stats = Object.fromEntries((data.interactionStatistic || []).map(item => [
        String(item.interactionType || "").split("/").pop(),
        Number(item.userInteractionCount)
      ]));
      if (Number.isFinite(stats.WriteAction)) {
        return {
          cid: bot.cid,
          name: bot.name,
          url: bot.url,
          messages: stats.WriteAction,
          collectors: Number.isFinite(stats.FollowAction) ? stats.FollowAction : null
        };
      }
    } catch {}
  }
  throw new Error("No interaction statistics found");
}

let history;
try { history = JSON.parse(await fs.readFile(historyPath, "utf8")); }
catch { history = { generated_at: null, snapshots: [] }; }

const results = [];
for (const bot of bots) {
  try {
    const stat = await fetchStats(bot);
    results.push(stat);
    console.log(`✓ ${bot.cid} ${bot.name}: ${stat.messages} / ${stat.collectors}`);
  } catch (error) {
    const previous = [...(history.snapshots || [])].reverse()
      .flatMap(s => s.bots || [])
      .find(x => x.cid === bot.cid);
    results.push({
      cid: bot.cid, name: bot.name, url: bot.url,
      messages: previous?.messages ?? null,
      collectors: previous?.collectors ?? null,
      stale: true,
      error: String(error.message || error)
    });
    console.error(`✗ ${bot.cid} ${bot.name}: ${error.message || error}`);
  }
  await new Promise(resolve => setTimeout(resolve, 1800));
}

const snapshot = { timestamp: new Date().toISOString(), bots: results };
history.generated_at = snapshot.timestamp;
history.snapshots = [...(history.snapshots || []), snapshot].slice(-800);
await fs.mkdir("data", { recursive: true });
await fs.writeFile(historyPath, JSON.stringify(history, null, 2));
