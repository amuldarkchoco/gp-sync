import { get, type About } from "../lib/api";
import { $, esc, html } from "../lib/dom";
import { date, duration } from "../lib/format";
import { icon } from "../lib/icons";
import { badge, cardHead } from "../lib/ui";
import type { View } from "./view";

interface Credit {
  name: string;
  role: string;
  url: string;
  version?: string;
}

function credits(a: About): { backend: Credit[]; frontend: Credit[] } {
  const p = a.packages;
  return {
    backend: [
      {
        name: "gpmc",
        role: "Google Photos mobile client: the library that talks to Google Photos",
        url: "https://github.com/xob0t/google_photos_mobile_client",
        version: p.gpmc,
      },
      {
        name: "Turso",
        role: "Open-source, SQLite-compatible database (Rust) for statistics, activity and logs",
        url: "https://github.com/tursodatabase/turso",
        version: p.pyturso,
      },
      { name: "SQLite", role: "Upload state", url: "https://sqlite.org", version: a.sqlite },
      {
        name: "Python",
        role: "The sync engine and REST API",
        url: "https://www.python.org",
        version: a.python,
      },
      { name: "Pillow", role: "Thumbnails", url: "https://python-pillow.org", version: p.pillow },
      {
        name: "pillow-heif",
        role: "iPhone HEIC photos",
        url: "https://github.com/bigcat88/pillow_heif",
        version: p["pillow-heif"],
      },
      {
        name: "Redis",
        role: "Optional shared cache (set REDIS_URL); the app caches in its own memory by default",
        url: "https://redis.io",
        version: p.redis,
      },
      { name: "Requests", role: "HTTP", url: "https://requests.readthedocs.io", version: p.requests },
      {
        name: "Rich",
        role: "Used by gpmc for progress",
        url: "https://github.com/Textualize/rich",
        version: p.rich,
      },
      { name: "uv and Ruff", role: "Python packaging, linting and formatting", url: "https://astral.sh" },
    ],
    frontend: Object.entries(__STACK__).map(([name, version]) => ({
      name,
      version,
      url:
        {
          "Vite+": "https://viteplus.dev",
          Vite: "https://vite.dev",
          Rolldown: "https://rolldown.rs",
          Oxlint: "https://oxc.rs",
          Oxfmt: "https://oxc.rs",
          Vitest: "https://vitest.dev",
          TypeScript: "https://www.typescriptlang.org",
          "Tailwind CSS": "https://tailwindcss.com",
          Lucide: "https://lucide.dev",
        }[name] ?? "#",
      role:
        {
          "Vite+": "Unified web toolchain (VoidZero): dev, check, test, build",
          Vite: "Dev server and build",
          Rolldown: "Bundler",
          Oxlint: "Linting and type checks",
          Oxfmt: "Formatting",
          Vitest: "Tests",
          TypeScript: "Typed dashboard code",
          "Tailwind CSS": "Styling",
          Lucide: "Icons",
        }[name] ?? "",
    })),
  };
}

function list(items: Credit[]): string {
  return items
    .map(
      (c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="row hover:bg-panel-2/50">
        <div class="min-w-0 flex-1"><div class="flex items-center gap-2 text-sm font-medium">${esc(c.name)}${c.version ? `<span class="badge font-mono">${esc(c.version)}</span>` : ""}</div><div class="truncate text-xs text-ink-3">${esc(c.role)}</div></div>${icon("external", "size-4 text-ink-3")}</a>`,
    )
    .join("");
}

const about: View = {
  subtitle: "Version and credits",
  mount(el) {
    el.innerHTML = `
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <section class="card relative overflow-hidden p-6 lg:col-span-12">
        <div class="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-accent/20 blur-3xl"></div>
        <div class="relative flex flex-col gap-5 sm:flex-row sm:items-center">
          <img src="icon.svg" alt="" class="size-20 rounded-2xl shadow-2xl">
          <div class="min-w-0 flex-1">
            <h2 class="text-2xl font-semibold">GP Sync</h2>
            <p class="mt-1 text-sm text-ink-2">Backs up your server's photos and videos to Google Photos in original quality. Files here are never changed.</p>
            <p class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"><span class="flex items-center gap-1.5">${icon("user", "size-4 text-ink-3")}Made by <a class="font-medium text-accent" href="https://github.com/kshanxs" target="_blank" rel="noopener">kshanxs</a></span><span class="flex items-center gap-1.5 text-ink-2">${icon("license", "size-4 text-ink-3")}MIT license · © 2026 kshanxs</span></p>
            <div class="mt-3 flex flex-wrap gap-1.5" id="ab-badges"><span class="skeleton h-5 w-40"></span></div>
          </div>
        </div>
      </section>
      <section class="card lg:col-span-4">${cardHead("Version", "package")}<div class="px-4 py-1" id="ab-version"></div></section>
      <section class="card lg:col-span-4">${cardHead("Sync engine", "server")}<div id="ab-back"></div></section>
      <section class="card lg:col-span-4">${cardHead("Dashboard", "code")}<div id="ab-front"></div></section>
      <section class="card lg:col-span-12">${cardHead("Credits", "heart", "Thank you to these open-source projects")}
        <div class="card-b grid grid-cols-1 gap-4 text-sm text-ink-2 md:grid-cols-2 xl:grid-cols-4">
          <p><b class="text-ink">App:</b> designed, built and maintained by <a class="text-accent" href="https://github.com/kshanxs" target="_blank" rel="noopener">kshanxs</a>, under the MIT license.</p>
          <p><b class="text-ink">Uploads:</b> <a class="text-accent" href="https://github.com/xob0t/google_photos_mobile_client" target="_blank" rel="noopener">gpmc</a> by xob0t (MIT), which talks to Google Photos like the Android app, so uploads keep their original quality. Signing in uses <a class="text-accent" href="https://revanced.app" target="_blank" rel="noopener">ReVanced</a> and GmsCore.</p>
          <p><b class="text-ink">Data:</b> <a class="text-accent" href="https://github.com/tursodatabase/turso" target="_blank" rel="noopener">Turso</a> and SQLite store statistics and upload state; answers are cached in the app's own memory (or <a class="text-accent" href="https://redis.io" target="_blank" rel="noopener">Redis</a> if you set one up); Pillow and pillow-heif make thumbnails.</p>
          <p><b class="text-ink">Dashboard:</b> TypeScript built with <a class="text-accent" href="https://viteplus.dev" target="_blank" rel="noopener">Vite+</a> by VoidZero, Tailwind CSS and Lucide icons. Runs on <a class="text-accent" href="https://umbrel.com" target="_blank" rel="noopener">Umbrel</a>.</p>
        </div>
        <div class="flex flex-wrap gap-2 border-t border-line p-4"><a class="btn" href="https://github.com/kshanxs/gp-sync" target="_blank" rel="noopener">${icon("branch")}Source code</a><a class="btn" href="#/settings/api">${icon("code")}REST API</a></div>
      </section>
    </div>`;
    void get<About>("about").then((a) => {
      const c = credits(a);
      html(
        $("#ab-badges"),
        [
          badge(`Version ${a.version}`, "info", "package"),
          badge(`Dashboard ${__WEB_VERSION__}`, "", "code"),
          a.commit ? badge(a.commit.slice(0, 7), "", "branch", "Build commit") : "",
          badge(a.stats_engine.split(" (")[0] ?? "", "good", "database"),
          badge("Read-only", "good", "lock"),
        ].join(""),
      );
      const rows: [string, string][] = [
        ["App", a.version],
        ["Dashboard", __WEB_VERSION__],
        ["Build", a.commit ? a.commit.slice(0, 12) : "local"],
        ["Built", a.built ? date(Date.parse(a.built) / 1000, true) : "–"],
        ["Running for", duration(a.uptime)],
        ["Scans every", `${a.interval_min} min`],
        ["Statistics", a.stats_engine],
        ["Media folder", a.media],
        ["Phone uploads", a.upload_dir],
      ];
      html(
        $("#ab-version"),
        rows
          .map(
            ([k, v]) =>
              `<div class="kv"><span>${k}</span><span class="truncate font-mono text-xs">${esc(v)}</span></div>`,
          )
          .join(""),
      );
      html($("#ab-back"), list(c.backend));
      html($("#ab-front"), list(c.frontend));
    });
  },
};

export default about;
