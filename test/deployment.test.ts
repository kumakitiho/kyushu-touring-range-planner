import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Pages deployment", () => {
  it("deploys pushes to main", () => {
    const workflow = readFileSync(".github/workflows/deploy-pages.yml", "utf8");
    expect(workflow).toContain("branches: [main]");
  });

  it("limits service worker caching to this app", () => {
    const worker = readFileSync("public/service-worker.js", "utf8");
    expect(worker).toContain('key.startsWith(CACHE_PREFIX)');
    expect(worker).toContain('url.origin !== BASE_URL.origin');
    expect(worker).toContain('url.pathname.startsWith(BASE_URL.pathname)');
  });
});
