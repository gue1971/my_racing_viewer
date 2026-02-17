import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const HORSES_DATA_FILE = path.join(ROOT, "horsesData.json");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const DEC_SJIS = new TextDecoder("shift_jis");
const DEC_EUC = new TextDecoder("euc-jp");

const OLD_ALIAS = new Map([
  ["日本ダービー", "東京優駿"],
  ["オークス", "優駿牝馬"],
  ["スプリンターズＳ", "スプリンターズS"],
  ["フェブラリーＳ", "フェブラリーS"],
  ["ＮＨＫマイルＣ", "NHKマイルC"],
  ["朝日杯フューチュリティＳ", "朝日杯FS"],
  ["マイルチャンピオンシップ", "マイルチャンピオンS"],
  ["ジャパンＣダート", "ジャパンカップダート"],
  ["ジャパンカップ", "ジャパンC"],
  ["エリザベス女王杯", "エリザベス女王杯"]
]);

function stripTags(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8544;/g, "I")
    .replace(/&#8545;/g, "II")
    .replace(/&#8546;/g, "III")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s) {
  return String(s || "")
    .normalize("NFKC")
    .replace(/[ 　\t\r\n]/g, "")
    .replace(/[()（）［］\[\]・･・,，\.．'’""]/g, "")
    .replace(/GI|G1|JpnI|JGI/gi, "")
    .trim();
}

function toIsoDate(s, year) {
  const m = String(s || "").match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return null;
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

async function fetchText(url, decoder) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
    }
  });
  if (!res.ok) {
    // JRA old pages can reject node-fetch UA handling while allowing curl.
    if (url.includes("www.jra.go.jp")) {
      const raw = execFileSync("curl", ["-s", "-A", UA, url], { encoding: "buffer" });
      return decoder.decode(raw);
    }
    throw new Error(`${res.status} ${url}`);
  }
  const buf = await res.arrayBuffer();
  return decoder.decode(new Uint8Array(buf));
}

function parseJraReplayOld(html, year) {
  const rows = [];
  for (const m of html.matchAll(/<TR>\s*<TD[^>]*>[\s\S]*?<\/TR>/gi)) {
    const tr = m[0];
    const tds = [...tr.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((x) => x[1]);
    if (tds.length < 7) continue;
    const dateMd = stripTags(tds[0]);
    const raceName = stripTags(tds[1]);
    const winner = stripTags(tds[4]);
    const resultHref = (tds[6].match(/HREF="([^"]+)"/i) || [])[1] || "";
    if (!dateMd || !raceName || !winner || !resultHref) continue;
    if (/障|グランドジャンプ|大障害/.test(raceName)) continue;
    const date = toIsoDate(dateMd, year);
    if (!date) continue;
    rows.push({ year, date, raceName, winner });
  }
  return rows;
}

function pickRaceIdFromDatePage(html, raceName) {
  const links = [...html.matchAll(/href="\/race\/([0-9A-Z]+)\/"\s+title="([^"]+)"/gi)].map(
    (m) => ({
      raceId: m[1],
      title: stripTags(m[2])
    })
  );

  const targetNames = [raceName, OLD_ALIAS.get(raceName)].filter(Boolean);
  const targetNorms = targetNames.map(norm);

  let best = null;
  for (const link of links) {
    const t = norm(link.title);
    let score = -1;
    for (const n of targetNorms) {
      if (!n || !t) continue;
      if (t === n) score = Math.max(score, 100);
      else if (t.includes(n) || n.includes(t)) score = Math.max(score, 70);
      else {
        const roughN = n.replace(/賞|記念|杯/g, "");
        const roughT = t.replace(/賞|記念|杯/g, "");
        if (roughN && roughT && (roughT.includes(roughN) || roughN.includes(roughT))) {
          score = Math.max(score, 40);
        }
      }
    }
    if (score >= 0 && (!best || score > best.score)) {
      best = { ...link, score };
    }
  }
  return best?.raceId || null;
}

function parseWinnerHorseFromRacePage(html) {
  const m = html.match(
    /<tr[^>]*>\s*<td[^>]*>\s*1\s*<\/td>[\s\S]*?<a href="\/horse\/([0-9]+)\/"[^>]*>([^<]+)<\/a>/i
  );
  if (!m) return null;
  return {
    horseId: m[1],
    winnerName: stripTags(m[2])
  };
}

function parseHorseResults(html) {
  const table = (html.match(/<table[^>]*class="[^"]*db_h_race_results[^"]*"[\s\S]*?<\/table>/i) || [])[0];
  if (!table) return [];
  const tbody = (table.match(/<tbody>([\s\S]*?)<\/tbody>/i) || [])[1];
  if (!tbody) return [];

  const races = [];
  for (const rowMatch of tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const row = rowMatch[1];
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    if (tds.length < 12) continue;

    const dateRaw = stripTags(tds[0]);
    const dateM = dateRaw.match(/(\d{4})\/(\d{2})\/(\d{2})/);
    if (!dateM) continue;
    const date = `${dateM[1]}-${dateM[2]}-${dateM[3]}`;

    const raceCell = tds[4] || "";
    const raceId = (raceCell.match(/\/race\/([0-9A-Z]+)\//i) || [])[1] || "";
    const raceName = stripTags(raceCell);

    const rankText = stripTags(tds[11]);
    const rank = Number(rankText);
    if (!Number.isFinite(rank) || rank <= 0) continue;

    const rec = {
      id: raceId,
      date,
      raceName,
      rank
    };

    if (rank === 1 && /\((?:GI|JpnI|JGI)\)/i.test(raceName)) {
      rec.star = true;
    }
    races.push(rec);
  }
  return races;
}

function readHorsesData() {
  return JSON.parse(fs.readFileSync(HORSES_DATA_FILE, "utf8"));
}

function writeHorsesData(data) {
  fs.writeFileSync(HORSES_DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

async function main() {
  const data = readHorsesData();
  const byHorseId = new Set(data.map((h) => String(h?.horseId || "")));
  const byName = new Set(data.map((h) => norm(h?.name)));

  const winners = [];
  for (let year = 2001; year <= 2005; year++) {
    const replayUrl = `https://www.jra.go.jp/datafile/seiseki/replay/${year}/g1.html`;
    const replayHtml = await fetchText(replayUrl, DEC_SJIS);
    winners.push(...parseJraReplayOld(replayHtml, year));
  }

  const uniqueByName = new Map();
  for (const w of winners) {
    const key = norm(w.winner);
    if (!key || uniqueByName.has(key)) continue;
    uniqueByName.set(key, w.winner);
  }

  const targetWinners = [...uniqueByName.values()].filter((name) => !byName.has(norm(name)));
  console.log(`target winners (missing in horsesData): ${targetWinners.length}`);

  const datePageCache = new Map();
  const added = [];

  for (const winnerName of targetWinners) {
    const winRows = winners.filter((w) => norm(w.winner) === norm(winnerName));
    const firstWin = winRows[0];
    if (!firstWin) continue;

    const ymd = firstWin.date.replaceAll("-", "");
    if (!datePageCache.has(ymd)) {
      datePageCache.set(
        ymd,
        await fetchText(`https://db.netkeiba.com/race/list/${ymd}/`, DEC_EUC)
      );
    }
    const datePage = datePageCache.get(ymd);

    const raceId = pickRaceIdFromDatePage(datePage, firstWin.raceName);
    if (!raceId) {
      console.warn(`skip ${winnerName}: raceId not found (${firstWin.date} ${firstWin.raceName})`);
      continue;
    }

    const raceHtml = await fetchText(`https://db.netkeiba.com/race/${raceId}/`, DEC_EUC);
    const winnerHorse = parseWinnerHorseFromRacePage(raceHtml);
    if (!winnerHorse?.horseId) {
      console.warn(`skip ${winnerName}: winner horse link not found (raceId=${raceId})`);
      continue;
    }

    if (norm(winnerHorse.winnerName) !== norm(winnerName)) {
      console.warn(
        `name mismatch ${winnerName} vs ${winnerHorse.winnerName} (raceId=${raceId})`
      );
    }

    if (byHorseId.has(winnerHorse.horseId)) {
      continue;
    }

    const horseResultHtml = await fetchText(
      `https://db.netkeiba.com/horse/result/${winnerHorse.horseId}/`,
      DEC_EUC
    );
    const races = parseHorseResults(horseResultHtml);
    if (races.length === 0) {
      console.warn(`skip ${winnerName}: no races parsed (horseId=${winnerHorse.horseId})`);
      continue;
    }

    data.push({
      horseId: winnerHorse.horseId,
      name: winnerHorse.winnerName,
      races
    });
    byHorseId.add(winnerHorse.horseId);
    byName.add(norm(winnerHorse.winnerName));
    added.push({ horseId: winnerHorse.horseId, name: winnerHorse.winnerName, races: races.length });
    console.log(`added ${winnerHorse.winnerName} (${winnerHorse.horseId}) races=${races.length}`);
  }

  writeHorsesData(data);
  console.log(`done. added=${added.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
