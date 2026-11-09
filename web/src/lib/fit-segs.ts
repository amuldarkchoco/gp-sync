// Segmented controls (.seg) on small screens: when the choices don't fit on one line they become
// an even grid (style.css, .seg[data-wrap]) instead of hiding choices off to the side.

const PHONE = "(max-width: 639px)";

/** True when a row of choices is wider than the space it has. */
export function overflows(contentWidth: number, boxWidth: number): boolean {
  return contentWidth > boxWidth + 1;
}

export function fitSegs(root: ParentNode = document): void {
  const phone = window.matchMedia(PHONE).matches;
  for (const seg of root.querySelectorAll<HTMLElement>(".seg")) {
    if (!phone) {
      delete seg.dataset.wrap;
      continue;
    }
    delete seg.dataset.wrap; // measure as one line
    if (overflows(seg.scrollWidth, seg.clientWidth)) seg.dataset.wrap = "";
  }
}

/** Keep every .seg fitted as pages render and the window changes size. */
export function watchSegs(): void {
  let queued = false;
  const run = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fitSegs();
    });
  };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", run);
  run();
}
