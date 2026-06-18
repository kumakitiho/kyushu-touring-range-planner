import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const root = process.cwd();
const spotsPath = path.join(root, "data", "kyushu-spots.json");
const userAgent = "KyushuTouringRangePlanner/0.1 local image metadata enrichment";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const useWikidata = args.has("--wikidata");
const allowFuzzy = args.has("--allow-fuzzy");
const pruneUnsafe = args.has("--prune-unsafe");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const requestDelayMs = Number(process.env.WIKIMEDIA_REQUEST_DELAY_MS || 1200);
let lastRequestAt = 0;

const categoryHints = {
  gourmet: "food restaurant local specialty",
  scenic: "景勝地 観光",
  road: "road route viewpoint",
  rest: "道の駅 温泉 休憩"
};

const spots = JSON.parse(await readFile(spotsPath, "utf8"));
let checked = 0;
let enriched = 0;
let skipped = 0;
let pruned = 0;

if (pruneUnsafe) {
  for (const spot of spots) {
    const images = spot.images ?? [];
    const safeImages = images.filter((image) => isLikelySpotImage(spot, image.sourceUrl));
    pruned += images.length - safeImages.length;
    spot.images = safeImages;
  }
  if (!dryRun) {
    await writeFile(spotsPath, `${JSON.stringify(spots, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ dryRun, pruned, total: spots.length }, null, 2));
  process.exit(0);
}

for (const spot of spots) {
  if (checked >= limit) break;
  if (!force && spot.images?.length) {
    skipped += 1;
    continue;
  }
  checked += 1;
  const image = await findSpotImage(spot).catch((error) => {
    console.warn(`[miss] ${spot.name}: ${error.message}`);
    return null;
  });
  if (image) {
    spot.images = [image];
    enriched += 1;
    console.log(`[hit] ${spot.name} -> ${image.sourceUrl}`);
  } else {
    skipped += 1;
    console.log(`[miss] ${spot.name}`);
  }
  await wait(requestDelayMs);
}

if (!dryRun) {
  await writeFile(spotsPath, `${JSON.stringify(spots, null, 2)}\n`, "utf8");
}

console.log(
  JSON.stringify(
    {
      dryRun,
      checked,
      enriched,
      skipped,
      pruned,
      total: spots.length
    },
    null,
    2
  )
);

async function findSpotImage(spot) {
  const commons = await findCommonsImage(spot);
  if (commons || !useWikidata) return commons;
  return findWikidataImage(spot);
}

async function findWikidataImage(spot) {
  const search = await getJson(
    "https://www.wikidata.org/w/api.php",
    {
      action: "wbsearchentities",
      format: "json",
      language: "ja",
      uselang: "ja",
      limit: "5",
      search: spot.name
    },
    "wikidata search"
  );
  const ids = (search.search ?? []).map((entry) => entry.id).filter(Boolean);
  if (ids.length === 0) return null;
  const entities = await getJson(
    "https://www.wikidata.org/w/api.php",
    {
      action: "wbgetentities",
      format: "json",
      props: "claims|labels",
      languages: "ja|en",
      ids: ids.join("|")
    },
    "wikidata entities"
  );
  for (const id of ids) {
    const entity = entities.entities?.[id];
    const fileName = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (!fileName) continue;
    const info = await commonsFileInfo(`File:${fileName}`);
    if (info) return imageFromInfo(info, spot);
  }
  return null;
}

async function findCommonsImage(spot) {
  const queries = [
    `${spot.name} ${spot.area}`,
    `${spot.name} ${categoryHints[spot.category] ?? ""}`,
    spot.name
  ];
  for (const query of queries) {
    const data = await getJson(
      "https://commons.wikimedia.org/w/api.php",
      {
        action: "query",
        format: "json",
        generator: "search",
        gsrnamespace: "6",
        gsrlimit: "5",
        gsrsearch: query,
        prop: "imageinfo",
        iiprop: "url|extmetadata|mime",
        iiurlwidth: "900"
      },
      "commons search"
    );
    const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const page of pages) {
      const info = page?.imageinfo?.[0];
      if (!info?.thumburl && !info?.url) continue;
      if (!String(info.mime ?? "").startsWith("image/")) continue;
      if (allowFuzzy || isLikelySpotImage(spot, page.title)) return imageFromInfo({ title: page.title, ...info }, spot);
    }
  }
  return null;
}

async function commonsFileInfo(title) {
  const data = await getJson(
    "https://commons.wikimedia.org/w/api.php",
    {
      action: "query",
      format: "json",
      titles: title,
      prop: "imageinfo",
      iiprop: "url|extmetadata|mime",
      iiurlwidth: "900"
    },
    "commons fileinfo"
  );
  const page = Object.values(data.query?.pages ?? {})[0];
  const info = page?.imageinfo?.[0];
  if (!info?.thumburl && !info?.url) return null;
  if (!String(info.mime ?? "").startsWith("image/")) return null;
  return { title: page.title, ...info };
}

function imageFromInfo(info, spot) {
  const meta = info.extmetadata ?? {};
  return {
    url: info.thumburl ?? info.url,
    alt: `${spot.name}の画像`,
    credit: cleanMeta(meta.Artist?.value) || cleanMeta(meta.Credit?.value) || "Wikimedia Commons contributors",
    license: cleanMeta(meta.LicenseShortName?.value) || cleanMeta(meta.UsageTerms?.value) || "Wikimedia Commons",
    sourceUrl: meta.ImageDescriptionUrl?.value || commonsFilePage(info.title)
  };
}

function isLikelySpotImage(spot, value) {
  const haystack = normalizeForMatch(value);
  const name = normalizeForMatch(spot.name);
  const area = normalizeForMatch(spot.area);
  if (name && haystack.includes(name)) return true;
  const withoutGeneric = name
    .replace(/^道の駅/, "")
    .replace(/駅$/, "")
    .replace(/[（）()]/g, "")
    .trim();
  if (withoutGeneric.length >= 3 && haystack.includes(withoutGeneric)) return true;
  if (spot.category === "rest" && name.startsWith("道の駅") && haystack.includes("michinoeki")) {
    return significantTerms(withoutGeneric).some((term) => haystack.includes(term));
  }
  if (area && name.length >= 4 && haystack.includes(area) && haystack.includes(name.slice(0, 4))) return true;
  return false;
}

function significantTerms(value) {
  return normalizeForMatch(value)
    .split(/[\s・･\-_/]+/)
    .filter((term) => term.length >= 3);
}

function normalizeForMatch(value) {
  return safeDecode(String(value ?? ""))
    .replace(/^file:/i, "")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function commonsFilePage(title) {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
}

function cleanMeta(value) {
  if (!value) return "";
  return String(value)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

async function getJson(baseUrl, params, label) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < requestDelayMs) await wait(requestDelayMs - elapsed);
    lastRequestAt = Date.now();
    const response = await fetch(url, {
      headers: {
        "Api-User-Agent": userAgent,
        "User-Agent": userAgent
      }
    });
    if (response.ok) return response.json();
    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      throw new Error(`${label} failed: ${response.status}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const retryDelay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 3000) : requestDelayMs * (attempt + 2);
    await wait(retryDelay);
  }
  throw new Error(`${label} failed`);
}
