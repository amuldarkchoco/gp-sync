import { expect, test } from "vite-plus/test";
import { uploadable, videoName } from "./upload-types";

test("accepts the same photo and video types as the server", () => {
  for (const name of [
    "a.JPG",
    "b.heic",
    "c.cr3",
    "d.RAF",
    "e.orf",
    "f.rw2",
    "g.srw",
    "h.pef",
    "i.mov",
    "j.mpeg",
  ])
    expect(uploadable(name)).toBe(true);
});

test("refuses types the server would reject", () => {
  for (const name of ["a.raw", "b.svg", "c.txt", "shared", "photo.jpg.exe"])
    expect(uploadable(name)).toBe(false);
});

test("recognises videos by name", () => {
  expect(videoName("clip.M2TS")).toBe(true);
  expect(videoName("photo.jpg")).toBe(false);
});
