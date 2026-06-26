import { describe, expect, it } from "vitest";
import { spotPopupHtml } from "../src/App";
import type { Spot } from "../src/shared/types";

const spot: Spot = {
  id: "spot-1",
  name: "海の<展望台>",
  category: "scenic",
  lat: 33.6,
  lng: 130.5,
  area: "福岡&佐賀",
  tags: ["海"],
  description: '眺望が"有名"です。<script>alert(1)</script>',
  images: []
};

describe("spotPopupHtml", () => {
  it("uses a compact text-only popup when the spot has no image", () => {
    const html = spotPopupHtml(spot);

    expect(html).not.toContain("<img");
    expect(html).toContain("海の&lt;展望台&gt;");
    expect(html).toContain("福岡&amp;佐賀");
    expect(html).not.toContain("<script>");
  });

  it("shows an image and escaped credit metadata when available", () => {
    const html = spotPopupHtml({
      ...spot,
      images: [
        {
          url: "https://example.com/view.jpg?size=large&fit=cover",
          alt: '海の"写真"',
          credit: "撮影者 <name>",
          license: "CC BY-SA 4.0",
          sourceUrl: "https://example.com/source?a=1&b=2"
        }
      ]
    });

    expect(html).toContain("<img");
    expect(html).toContain("size=large&amp;fit=cover");
    expect(html).toContain("海の&quot;写真&quot;");
    expect(html).toContain("撮影者 &lt;name&gt; / CC BY-SA 4.0");
    expect(html).toContain("source?a=1&amp;b=2");
  });
});
