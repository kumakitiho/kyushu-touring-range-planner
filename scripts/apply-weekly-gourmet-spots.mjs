import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const spotsPath = path.join(rootDir, 'data', 'kyushu-spots.json');
const weeklyPath = path.join(rootDir, 'data', 'weekly-gourmet-spots.json');

const normalize = (value) => String(value ?? '').trim().toLowerCase();
const distanceKm = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(h));
};

const spots = JSON.parse(fs.readFileSync(spotsPath, 'utf8'));
const weeklySpots = JSON.parse(fs.readFileSync(weeklyPath, 'utf8'));

const existingIds = new Set(spots.map((spot) => spot.id));
const existingNames = new Set(spots.map((spot) => normalize(spot.name)));

const added = [];
const skipped = [];

for (const spot of weeklySpots) {
  const sameId = existingIds.has(spot.id);
  const sameName = existingNames.has(normalize(spot.name));
  const nearbySameCategory = spots.find(
    (existing) =>
      existing.category === spot.category &&
      existing.area === spot.area &&
      Number.isFinite(existing.lat) &&
      Number.isFinite(existing.lng) &&
      distanceKm(existing, spot) < 0.15,
  );

  if (sameId || sameName || nearbySameCategory) {
    skipped.push({
      id: spot.id,
      name: spot.name,
      reason: sameId ? 'same id' : sameName ? 'same name' : `nearby same category: ${nearbySameCategory.name}`,
    });
    continue;
  }

  spots.push(spot);
  existingIds.add(spot.id);
  existingNames.add(normalize(spot.name));
  added.push(spot.name);
}

if (added.length > 0) {
  fs.writeFileSync(spotsPath, `${JSON.stringify(spots, null, 2)}\n`);
}

console.log(`weekly gourmet spots: added=${added.length}, skipped=${skipped.length}`);
if (added.length > 0) console.log(`added: ${added.join(', ')}`);
if (skipped.length > 0) console.log(`skipped: ${skipped.map((item) => `${item.name} (${item.reason})`).join(', ')}`);
