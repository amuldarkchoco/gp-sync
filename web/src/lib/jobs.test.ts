import { describe, expect, it } from "vite-plus/test";
import { jobLink, jobStep, jobTitle } from "./jobs";

describe("background jobs", () => {
  it("names the account, and both for a copy", () => {
    expect(jobTitle({ kind: "storage", account: "a@x.com" })).toBe("Free storage · a@x.com");
    expect(jobTitle({ kind: "copy", account: "a@x.com", to: "b@x.com" })).toBe("Copy · a@x.com → b@x.com");
  });

  it("says what it is doing to which file", () => {
    expect(jobStep({ kind: "dates", account: "a", step: "deleting", name: "Photos/s/x.jpg" })).toBe(
      "Replacing in Google x.jpg",
    );
    expect(jobStep({ kind: "library", account: "a" })).toBe("");
    expect(jobLink({ kind: "copy", account: "a" })).toBe("#/copy");
  });
});
