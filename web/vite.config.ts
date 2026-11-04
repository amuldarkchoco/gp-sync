import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";
import { versions } from "vite-plus/versions";

// Versions shown on the About page, read from the installed packages at build time.
function versionOf(name: string): string {
  try {
    const url = new URL(`./node_modules/${name}/package.json`, import.meta.url);
    return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
  } catch {
    return "";
  }
}

const app = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  base: "./", // works behind Umbrel's proxy and at any path
  plugins: [tailwindcss()],
  define: {
    __WEB_VERSION__: JSON.stringify(app.version),
    __STACK__: JSON.stringify({
      "Vite+": versionOf("vite-plus"),
      Vite: versions.vite,
      Rolldown: versions.rolldown,
      Oxlint: versions.oxlint,
      Oxfmt: versions.oxfmt,
      Vitest: versions.vitest,
      TypeScript: versionOf("typescript"),
      "Tailwind CSS": versionOf("tailwindcss"),
      Lucide: versionOf("lucide"),
    }),
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 400,
  },
  server: {
    // `vp dev` talks to a running app (default: the local test server).
    proxy: { "/api": process.env.API_URL ?? "http://127.0.0.1:8527" },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
  lint: {
    ignorePatterns: ["dist/**", "public/**", "node_modules/**"],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    printWidth: 110,
    ignorePatterns: ["dist/**", "public/**", "node_modules/**"],
  },
});
