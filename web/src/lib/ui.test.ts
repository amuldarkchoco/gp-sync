import { describe, expect, it } from "vite-plus/test";
import { tile } from "./ui";

describe("metric tiles", () => {
  it("keeps the shared styling and live-update hooks", () => {
    const markup = tile({ id: "metric", label: "Upload", value: "–", ic: "up", chart: "" });
    expect(markup).toContain('class="card metric-card lift');
    expect(markup).toContain('id="metric"');
    expect(markup).toContain("data-v");
    expect(markup).toContain("data-s");
    expect(markup).toContain("data-c");
  });

  it("escapes the label and omits the chart container when not requested", () => {
    const markup = tile({ label: "<Files>", value: "0", ic: "photo" });
    expect(markup).toContain("&lt;Files&gt;");
    expect(markup).not.toContain("data-c");
  });
});
