import { readFileSync, writeFileSync } from "node:fs";

const plannerPath = new URL("../server/planner.ts", import.meta.url);
const candidateLimitConstant = "const MAX_FILTERED_CANDIDATES = 200;";
let source = readFileSync(plannerPath, "utf8");

if (!source.includes(candidateLimitConstant)) {
  source = source.replace(
    "const RETURN_LOOP_OVERLAP_TOLERANCE_KM = 0.25;",
    `const RETURN_LOOP_OVERLAP_TOLERANCE_KM = 0.25;\n${candidateLimitConstant}`
  );
}

source = source.replace(/\.slice\(0,\s*42\)/g, ".slice(0, MAX_FILTERED_CANDIDATES)");

writeFileSync(plannerPath, source);
console.log("Planner candidate limit is set to 200.");
