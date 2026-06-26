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
    expect(worker).toContain('url.pathname.includes("/api/")');
    expect(worker).toContain('request.mode === "navigate"');
    expect(worker).toContain("caches.match(BASE_URL.toString())");
  });

  it("ships an installable standalone manifest and registers its worker under the Pages base path", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
    const main = readFileSync("src/main.tsx", "utf8");
    const index = readFileSync("index.html", "utf8");

    expect(manifest).toMatchObject({ start_url: ".", scope: ".", display: "standalone" });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([expect.objectContaining({ src: "icons/icon.svg", purpose: expect.stringContaining("maskable") })])
    );
    expect(index).toContain('rel="manifest" href="%BASE_URL%manifest.webmanifest"');
    expect(main).toContain("import.meta.env.PROD");
    expect(main).toContain("${import.meta.env.BASE_URL}service-worker.js");
  });

  it("ships personal-use indexing and browser security guards", () => {
    const index = readFileSync("index.html", "utf8");
    const app = readFileSync("src/App.tsx", "utf8");
    const robots = readFileSync("public/robots.txt", "utf8");
    const serverIndex = readFileSync("server/index.ts", "utf8");
    expect(index).toContain('name="robots" content="noindex, nofollow, noarchive"');
    expect(index).toContain('http-equiv="Content-Security-Policy"');
    const csp = index.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? "";
    expect(csp.split(";").map((directive) => directive.trim())).toContain(
      "connect-src 'self' https://valhalla1.openstreetmap.de"
    );
    expect(readFileSync("server/routing.ts", "utf8")).toContain("navigator.locks.request");
    expect(robots).toContain("Disallow: /");
    expect(app).toContain("OpenStreetMap contributors");
    expect(app.indexOf("本アプリは現在地を保存しません")).toBeLessThan(app.indexOf('className="locate-chip"'));
    expect(app).toContain("https://www.openstreetmap.org/fixthemap");
    expect(app).toContain("https://www.fossgis.de/datenschutzerklaerung/");
    expect(app).toContain("運営側のログに保存される場合があります");
    expect(app).toContain('href="mailto:s.kuma100ten@gmail.com"');
    expect(serverIndex).toContain('listen(port, "127.0.0.1"');
  });
});
