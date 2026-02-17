import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const HORSES_DATA = path.join(ROOT, "horsesData.json");
const OUT_FILE = path.join(ROOT, "g1_winners_2001_2025.json");

const COMMON_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
};

const sjisDecoder = new TextDecoder("shift_jis");

function normalizeName(name) {
  return String(name || "").replace(/\s+/g, "").trim();
}

function readHorseIdMap() {
  const raw = fs.readFileSync(HORSES_DATA, "utf8");
  const horses = JSON.parse(raw);
  const map = new Map();
  for (const h of horses) {
    const key = normalizeName(h?.name);
    if (key) map.set(key, String(h?.horseId || ""));
  }
  return map;
}

async function fetchSjisText(url) {
  const res = await fetch(url, { headers: COMMON_HEADERS });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  return sjisDecoder.decode(new Uint8Array(buf));
}

function parseReplayRows(html, year) {
  const rows = [];
  for (const m of html.matchAll(/<tr class="yellow-x">([\s\S]*?)<\/tr>/g)) {
    const rowHtml = m[1];
    const raceName = (rowHtml.match(/<td class="race">[\s\S]*?<a [^>]*>([^<]+)<\/a>/) || [])[1]?.trim();
    const winner = (rowHtml.match(/<td class="winner">\s*([^<]+?)\s*<\/td>/) || [])[1]?.trim();
    const resultHref = (rowHtml.match(/<td class="result">[\s\S]*?<a href="([^"]+)"/) || [])[1]?.trim();
    if (!raceName || !resultHref) continue;
    if (/障害|グランドジャンプ|大障害/.test(raceName)) continue;
    rows.push({
      year,
      raceName,
      winner: winner || null,
      resultHref
    });
  }
  return rows;
}

function parseWinnerFromResultPage(html) {
  const table = (html.match(/<TABLE[^>]*ID=W01D_D2[\s\S]*?<\/TABLE>/i) || [])[0];
  if (!table) return null;
  const firstRow = (table.match(/<TR>[\s\S]*?<\/TR>\s*<TR>([\s\S]*?)<\/TR>/i) || [])[1];
  if (!firstRow) return null;
  const winner = (firstRow.match(/<TD[^>]*NOWRAP>\s*([^<]+?)\s*<\/TD>/g) || [])
    .map(s => s.replace(/<[^>]+>/g, "").trim())
    .find((v) => v && !/^\d+$/.test(v) && !/(牡|牝|せん|kg|馬身|Kg|[0-9]:[0-9])/.test(v));
  return winner || null;
}

async function build() {
  const horseIdMap = readHorseIdMap();

  const allRaceWins = [];

  // 2002-2025: 年別G1一覧の winner 列から取得
  for (let year = 2002; year <= 2025; year++) {
    const url = `https://www.jra.go.jp/datafile/seiseki/replay/${year}/g1.html`;
    const html = await fetchSjisText(url);
    const rows = parseReplayRows(html, year);
    allRaceWins.push(...rows.filter(r => r.winner).map(r => ({
      year: r.year,
      raceName: r.raceName,
      winner: r.winner
    })));
  }

  // 2001: replay/2001/g1.html が 403 のため、2002 の結果URLを 2001 版に置換して 1着馬を抽出
  {
    const html2002 = await fetchSjisText("https://www.jra.go.jp/datafile/seiseki/replay/2002/g1.html");
    const rows2002 = parseReplayRows(html2002, 2002);
    for (const r of rows2002) {
      const result2001Path = r.resultHref.replace(/2002/g, "2001");
      const abs = `https://www.jra.go.jp${result2001Path}`;
      try {
        const resultHtml = await fetchSjisText(abs);
        const winner = parseWinnerFromResultPage(resultHtml);
        if (winner) {
          allRaceWins.push({
            year: 2001,
            raceName: r.raceName,
            winner
          });
        }
      } catch {
        // 取得不可のレースはスキップ
      }
    }
  }

  // 馬ごとに集約
  const byHorse = new Map();
  for (const row of allRaceWins) {
    const key = normalizeName(row.winner);
    if (!key) continue;
    if (!byHorse.has(key)) {
      byHorse.set(key, {
        name: row.winner,
        horseId: horseIdMap.get(key) || "",
        firstWinYear: row.year,
        lastWinYear: row.year,
        winCount: 1
      });
    } else {
      const item = byHorse.get(key);
      item.firstWinYear = Math.min(item.firstWinYear, row.year);
      item.lastWinYear = Math.max(item.lastWinYear, row.year);
      item.winCount += 1;
    }
  }

  const winners = [...byHorse.values()]
    .filter((x) => x.firstWinYear >= 2001 && x.lastWinYear <= 2025)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));

  fs.writeFileSync(OUT_FILE, JSON.stringify(winners, null, 2), "utf8");

  const withId = winners.filter((w) => w.horseId).length;
  console.log(`Generated: ${OUT_FILE}`);
  console.log(`Total winners: ${winners.length}`);
  console.log(`Matched horseId from horsesData: ${withId}`);
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});

