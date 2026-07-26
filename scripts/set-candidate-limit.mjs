import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const dataDirectory = new URL("../data/", import.meta.url);
const baseSpotsPath = new URL("../data/kyushu-spots.json", import.meta.url);
const generatedSpotsPath = new URL("../data/kyushu-spots.generated.json", import.meta.url);
const plannerPath = new URL("../server/planner.ts", import.meta.url);
const candidateLimitConstant = "const MAX_FILTERED_CANDIDATES = 200;";

function normalizeName(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・･ー\-_'’"“”()（）]/g, "");
}

const baseSpots = JSON.parse(readFileSync(baseSpotsPath, "utf8"));
const weeklySpotFiles = readdirSync(dataDirectory)
  .filter((fileName) => /^weekly-spots-\d{4}-\d{2}-\d{2}\.json$/.test(fileName))
  .sort();

const mergedSpots = [...baseSpots];
const knownIds = new Set(baseSpots.map((spot) => spot.id));
const knownNames = new Set(baseSpots.map((spot) => `${spot.area}:${normalizeName(spot.name)}`));
let addedSpotCount = 0;

for (const fileName of weeklySpotFiles) {
  const weeklySpots = JSON.parse(readFileSync(new URL(fileName, dataDirectory), "utf8"));
  for (const spot of weeklySpots) {
    const nameKey = `${spot.area}:${normalizeName(spot.name)}`;
    if (knownIds.has(spot.id) || knownNames.has(nameKey)) continue;
    mergedSpots.push(spot);
    knownIds.add(spot.id);
    knownNames.add(nameKey);
    addedSpotCount += 1;
  }
}

writeFileSync(generatedSpotsPath, `${JSON.stringify(mergedSpots, null, 2)}\n`);

let source = readFileSync(plannerPath, "utf8");
source = source.replace(
  'import rawSpots from "../data/kyushu-spots.json";',
  'import rawSpots from "../data/kyushu-spots.generated.json";'
);

if (!source.includes(candidateLimitConstant)) {
  source = source.replace(
    "const RETURN_LOOP_OVERLAP_TOLERANCE_KM = 0.25;",
    `const RETURN_LOOP_OVERLAP_TOLERANCE_KM = 0.25;\n${candidateLimitConstant}`
  );
}

source = source.replace(/\.slice\(0,\s*42\)/g, ".slice(0, MAX_FILTERED_CANDIDATES)");

writeFileSync(plannerPath, source);
console.log(`Planner candidate limit is set to 200. Loaded ${addedSpotCount} weekly spots from ${weeklySpotFiles.length} file(s).`);
