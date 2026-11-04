import type { Status } from "../lib/api";

/** A page of the dashboard. */
export interface View {
  subtitle?: string;
  /** Build the page. `args` are the parts of the URL after the page name (#/settings/alerts). */
  mount(el: HTMLElement, args: string[]): void;
  /** Called with fresh status every 2 seconds while the page is open. */
  update?(s: Status): void;
  /** The URL changed but the page stayed (for example a settings section). */
  route?(args: string[]): void;
  unmount?(): void;
}
