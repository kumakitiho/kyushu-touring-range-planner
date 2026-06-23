import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GitHub Pages deployment", () => {
  it("deploys pushes to main", () => {
    const workflow = readFileSync(".github/workflows/deploy-pages.yml", "utf8");
    expect(workflow).toContain("branches: [main]");
    const actionReferences = [...workflow.matchAll(/uses:\s+[^\s]+@([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences).toHaveLength(5);
    expect(actionReferences.every((reference) => /^[0-9a-f]{40}$/.test(reference))).toBe(true);
    expect(workflow.match(/^\s+with:/gm)).toHaveLength(2);
    expect(workflow).toContain("pages: write");
    expect(workflow.indexOf("pages: write")).toBeGreaterThan(workflow.indexOf("deploy:"));
  });

  it("limits service worker caching to this app", () => {
    const worker = readFileSync("public/service-worker.js", "utf8");
    expect(worker).toContain('key.startsWith(CACHE_PREFIX)');
    expect(worker).toContain('url.origin !== BASE_URL.origin');
    expect(worker).toContain('url.pathname.startsWith(BASE_URL.pathname)');
  });

  it("ships personal-use indexing and browser security guards", () => {
    const index = readFileSync("index.html", "utf8");
    const app = readFileSync("src/App.tsx", "utf8");
    const robots = readFileSync("public/robots.txt", "utf8");
    expect(index).toContain('name="robots" content="noindex, nofollow, noarchive"');
    expect(index).toContain('http-equiv="Content-Security-Policy"');
    const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
    expect(csp.split(";").map((directive) => directive.trim())).toContain(
      "connect-src 'self' https://router.project-osrm.org"
    );
    expect(readFileSync("server/routing.ts", "utf8")).toContain("navigator.locks.request");
    expect(robots).toContain("Disallow: /");
    expect(app).toContain("OpenStreetMap contributors");
    expect(app.indexOf("本アプリは現在地を保存しません")).toBeLessThan(app.indexOf('className="locate-chip"'));
    expect(app).toContain("https://www.openstreetmap.org/fixthemap");
    expect(app).toContain("https://routing.openstreetmap.de/about.html");
    expect(app).toContain("運営側のログに保存される場合があります");
    expect(app).toContain('href="mailto:s.kuma100ten@gmail.com"');
  });
});
