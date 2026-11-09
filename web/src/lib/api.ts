// Typed access to the app's REST API (all paths relative, so it works behind any proxy).

export interface Counts {
  uploaded: number;
  exists: number;
  failed: number;
  gave_up: number;
}
export interface Library {
  files: number;
  bytes: number;
  synced_files: number;
  synced_bytes: number;
  photos?: number;
  videos?: number;
  photo_bytes?: number;
  video_bytes?: number;
}
export interface Folder {
  files: number;
  bytes: number;
  synced_files: number;
  synced_bytes: number;
  /** Main account ("" = not backed up). */
  account: string;
  /** Every account the folder goes to, main first. */
  accounts?: string[];
  /** Extra account -> files copied there. */
  copies?: Record<string, number>;
}
export interface Current {
  name: string;
  bytes_done: number;
  bytes_total: number;
  step: string;
  kind: "photo" | "video";
  account: string;
}
export interface LogItem {
  time: number;
  kind: string;
  text: string;
  name: string | null;
}
export interface Resources {
  cpu: number[];
  mem: number[];
  read: number[];
  write: number[];
  cpu_now: number;
  mem_now: number;
  read_now: number;
  write_now: number;
  mem_limit: number;
  cores: number;
  latency: { time: number; ms: number | null }[];
  latency_now: number | null;
  latency_avg: number | null;
}
export interface Status {
  version: string;
  /** What the machine is called ("Umbrel", or "this server"). */
  host: string;
  /** True when the dashboard asks for a password. */
  auth?: boolean;
  phase: string;
  error: string;
  done: number;
  total: number;
  last_scan: number;
  interval: number;
  paused: boolean;
  stats_engine: string;
  account: string;
  accounts: string[];
  login_failed: string[];
  schedule: { enabled: boolean; start: number; end: number; allowed: boolean; next_window: number };
  speed_limit_mbps: number;
  max_accounts?: number;
  copies?: Record<string, { done: number; failed: number }>;
  copies_pending?: number;
  /** Background work right now, per account (and copy pair). */
  jobs?: Job[];
  /** Files with no date of their own, and fixes waiting for the user to delete the item in Google. */
  dates?: { undated: number; waiting: number };
  /** The user has seen the "album for files without a date" choice. */
  undated_asked?: boolean;
  current: Current | null;
  library: Library;
  folders: Record<string, Folder>;
  session: { started: number; uploaded_files: number; uploaded_bytes: number };
  counts: Counts;
  net: {
    up: number[];
    down: number[];
    up_now: number;
    down_now: number;
    up_avg: number;
    sent: number;
    received: number;
  };
  failed: { name: string; error: string; attempts: number; time: number }[];
  pending: string[];
  settle_seconds: number;
  log: LogItem[];
  resources: Resources;
  now: number;
}
export interface Day {
  day: string;
  photos: number;
  videos: number;
  photo_bytes: number;
  video_bytes: number;
  existing: number;
  failed: number;
  net_sent: number;
  net_received: number;
  photo_ms?: number;
  video_ms?: number;
  peak_up: number;
  peak_down: number;
}
export interface History {
  days: number;
  first: string;
  today: string;
  data: Day[];
}
export interface Totals {
  photos: number;
  videos: number;
  photo_bytes: number;
  video_bytes: number;
  existing: number;
  failed: number;
  net_sent: number;
  net_received: number;
  photo_ms: number;
  video_ms: number;
  peak_up: number;
  since: number;
}
export interface KindInsight {
  avg_ms: number;
  max_ms: number;
  avg_bytes: number;
  avg_uploaded_bytes: number;
  files: number;
  bytes: number;
}
export interface UploadRow {
  time: number;
  name: string;
  kind: string;
  bytes: number;
  ms: number;
}
export interface Insights {
  upload_ms: number;
  uploaded: number;
  timed_files: number;
  avg_ms: number;
  avg_speed: number;
  photo: KindInsight;
  video: KindInsight;
  types: { ext: string; files: number; bytes: number }[];
  by_hour: number[];
  by_weekday: number[];
  largest: UploadRow[];
  slowest: UploadRow[];
}
export interface MetricPoint {
  time: number;
  up: number;
  up_max: number;
  down: number;
  down_max: number;
  cpu: number;
  mem: number;
  latency: number | null;
}
export interface Metrics {
  hours: number;
  step_min: number;
  points: MetricPoint[];
}
export interface Health {
  version: string;
  gpmc: string;
  python: string;
  stats_engine: string;
  uptime: number;
  disk_data: { total: number; used: number; free: number } | null;
  disk_media: { total: number; used: number; free: number } | null;
  db_bytes: number;
  stats_bytes: number;
  thumbs_bytes: number;
  cache?: {
    backend: string;
    connected: boolean;
    version?: string;
    used: number;
    limit?: number;
    keys: number;
    hits: number;
    misses: number;
    hit_rate: number;
  };
  accounts: {
    email: string;
    login_saved: number | null;
    last_success: number | null;
    login_rejected: boolean;
  }[];
  phase: string;
  error: string;
  last_scan: number;
  checks: { media_readable: boolean; upload_folder: boolean; turso: boolean; errors_24h: number };
}
export interface About {
  version: string;
  host: string;
  commit: string;
  built: string;
  python: string;
  sqlite: string;
  stats_engine: string;
  packages: Record<string, string>;
  started: number;
  uptime: number;
  media: string;
  upload_dir: string;
  interval_min: number;
}
export interface Notify {
  ntfy_url: string;
  ntfy_token: string;
  ntfy_token_set?: boolean;
  telegram_token: string;
  telegram_token_set?: boolean;
  telegram_chat: string;
  on_login: boolean;
  on_gave_up: boolean;
  on_round: boolean;
  round_min: number;
  weekly: boolean;
}
export interface Settings {
  folders: Record<string, string> | null;
  schedule: { enabled: boolean; start: number; end: number };
  tz_offset_min: number;
  speed_limit_mbps: number;
  albums: "off" | "top" | "parent";
  notify: Notify;
  hash_existing: boolean;
  /** Folders whose files upload first, in this order ("Photos/iPhone"). */
  priority?: string[];
  /** Photos and videos with no date of their own go into this album. */
  undated: { album: boolean; name: string; asked: boolean };
  /** What to do in Google with items saved from apps (Sources page). */
  sources?: SourceSettings;
  /** Copies between accounts are paused (read only: change it with copy/pause). */
  copy_paused?: boolean;
}
export type SourceId =
  | "camera"
  | "snapchat"
  | "instagram"
  | "tiktok"
  | "whatsapp"
  | "telegram"
  | "screenshot"
  | "app_export"
  | "unknown";
export type AppSourceId = Exclude<SourceId, "camera" | "unknown">;
export interface SourceActions {
  album: boolean;
  album_name: string;
  caption: boolean;
  archive: boolean;
}
export type SourceSettings = { asked: boolean; estimate_dates: boolean } & Record<AppSourceId, SourceActions>;
export interface SourceItem {
  name: string;
  kind: "photo" | "video";
  size: number;
  mtime: number;
  /** The label in use: the user's decision, or the detected one. */
  source: SourceId;
  detected: SourceId;
  decided: boolean;
  app: string;
  device: string;
  app_version: string;
  os_version: string;
  taken: number | null;
  /** marker = definite (a record inside the file), name = file name, likely = no camera data. */
  confidence: "marker" | "name" | "likely" | "";
  reasons: string[];
  estimate: { date: number; lo: number; hi: number; reason: string } | null;
  uploaded: boolean;
  google_url: string;
  album: string;
  archived: boolean;
  captioned: string;
}
export interface SourcesReport {
  source: SourceId;
  sources: SourceId[];
  app_sources: AppSourceId[];
  labels: Record<SourceId, string>;
  counts: Record<SourceId, number>;
  devices: { name: string; files: number }[];
  checked: number;
  total: number;
  estimated: number;
  items: SourceItem[];
  more: number;
  settings: SourceSettings;
  account: string;
  refreshed: number | null;
  refreshing: boolean;
  needs_library: boolean;
  error: string;
}
export interface DateItem {
  name: string;
  kind: "photo" | "video";
  size: number;
  /** Date Google Photos shows (unix seconds), null when unknown. */
  google: number | null;
  /** Whether Google supplied this date, or it is only the last value sent during upload. */
  google_source: "google" | "sent" | "unknown";
  /** Last known date when this fix was started; older fixes may not have recorded one. */
  previous_google: number | null;
  previous_google_source: "google" | "sent" | "unknown";
  /** Date it should have. */
  best: number;
  /** manual = picked by the user, copy = earliest identical copy, file = the file's own time,
   * google = Google already has an earlier (better) date, filename = a date in the file name,
   * estimated = the estimated save date of a Snapchat item. */
  source: "manual" | "copy" | "file" | "google" | "filename" | "estimated";
  manual: number | null;
  wrong: boolean;
  fix: "" | "waiting" | "in_google" | "done" | "failed";
  error: string;
  google_url: string;
}
export interface DatesReport {
  account: string;
  accounts: string[];
  refreshed: number | null;
  refreshing: boolean;
  items: DateItem[];
  undated: number;
  wrong: number;
  waiting: number;
  fixed: number;
  checked: number;
  album: string;
  current: { key: string; step?: "deleting" | "uploading"; done: number; total: number } | null;
  error: string;
}
export interface FileItem {
  name: string;
  size: number;
  status: string;
  kind: "photo" | "video";
  account: string;
  updated: number;
  error: string;
  attempts: number;
  google_url: string;
  mtime?: number;
  /** No capture date inside the file. */
  undated?: boolean;
}
export interface FolderGroup {
  /** Subfolder or device name; "" = files sitting in the folder itself. */
  name: string;
  /** Folders it covers (a device can have several, e.g. "Photos/Pixel" and "Photos/Pixel (2)"). */
  folders: string[];
  has_sub: boolean;
  files: number;
  photos: number;
  videos: number;
  bytes: number;
  synced: number;
  /** Files added in the chosen range. */
  new: number;
  new_week: number;
  last_added: number;
  /** Files added per day over the range, oldest first. */
  series: number[];
  /** True for the folder this app's Upload page writes to. */
  uploads: boolean;
  /** Its newest files (up to 4), for thumbnails. */
  recent?: string[];
  /** A phone's folder (filled by a backup app with folders 00..ff): opens as a device. */
  device?: boolean;
}
export interface FolderReport {
  ready: boolean;
  path: string;
  group: "folders" | "devices";
  days: number;
  today: string;
  total: {
    files: number;
    photos: number;
    videos: number;
    bytes: number;
    photo_bytes: number;
    video_bytes: number;
    synced: number;
    new: number;
    new_week: number;
    new_day: number;
    last_added: number;
  };
  daily: {
    day: string;
    photos: number;
    videos: number;
    backed_up: number;
    waiting: number;
    failed: number;
  }[];
  children: FolderGroup[];
  /** The subfolders were a backup app's 00..ff folders: not listed, the photos are shown instead. */
  buckets?: boolean;
  /** At the top: folders that aren't backed up (not counted), with how many files they hold. */
  not_backed_up?: { name: string; files: number }[];
}
export interface FolderFiles {
  path: string;
  total: number;
  counts: { all: number; backed_up: number; waiting: number; failed: number; photo: number; video: number };
  items: {
    name: string;
    kind: "photo" | "video";
    size: number;
    added: number;
    mtime: number;
    state: "backed_up" | "waiting" | "failed";
    error: string;
  }[];
}
export interface Duplicates {
  groups: { sha1: string; count: number; size: number; wasted: number; files: string[] }[];
  wasted: number;
  hashed: number;
  total: number;
}
export type ReclaimState =
  | ""
  | "queued"
  | "downloaded"
  | "in_google"
  | "checking"
  | "done"
  | "counts"
  | "counted"
  | "failed";
export interface StorageItem {
  key: string;
  name: string;
  kind: "photo" | "video";
  size: number;
  /** Bytes it counts against Google storage. */
  quota: number;
  taken: number;
  google_url: string;
  state: ReclaimState;
  error?: string;
  updated?: number;
}
export interface StorageReport {
  account: string;
  listed: boolean;
  refreshed: number | null;
  refreshing: boolean;
  error: string;
  /** Google counted one of our re-uploads: nothing more is moved. */
  blocked: boolean;
  current: {
    key: string;
    step: "downloading" | "deleting" | "uploading";
    done: number;
    total: number;
  } | null;
  free_space: number;
  total: number;
  counted: number;
  counted_bytes: number;
  /** GP Sync's own uploads found in the library, and how many of them count (should be 0). */
  ours: { seen: number; counted: number };
  freed: { count: number; bytes: number };
  /** What counts against storage, photos and videos apart. */
  kinds?: Record<"photo" | "video", { count: number; bytes: number }>;
  items: StorageItem[];
}
export interface CopyItem {
  key: string;
  name: string;
  kind: "photo" | "video";
  size: number;
  taken: number;
  state: "queued" | "copied" | "done" | "exists" | "failed" | "counts";
  error: string;
  updated: number;
}
export interface CopyCandidate {
  key: string;
  name: string;
  kind: "photo" | "video";
  size: number;
  taken: number;
}
export interface CopyCandidates {
  total: number;
  bytes: number;
  items: CopyCandidate[];
}
export interface CopyReport {
  src: string;
  dst: string;
  /** False when fewer than two accounts are connected. */
  ready?: boolean;
  accounts?: string[];
  listed: { src: boolean; dst: boolean };
  refreshed: { src: number | null; dst: number | null };
  refreshing: boolean;
  error: string;
  paused: boolean;
  current: {
    key: string;
    name: string;
    step: "downloading" | "uploading";
    done: number;
    total: number;
  } | null;
  src_total: number;
  in_dst: number;
  /** Never copied: already in the other account, or the same file twice. `error` says which. */
  duplicates: { count: number; bytes: number; items: CopyItem[] };
  todo: Record<"photo" | "video", { count: number; bytes: number }>;
  /** Year -> items still to copy. */
  years: Record<string, number>;
  jobs: {
    queued: number;
    queued_bytes: number;
    copied: number;
    copied_bytes: number;
    verified: number;
    exists: number;
    failed: number;
    counts: number;
  };
  recent: CopyItem[];
  failed: CopyItem[];
  free_space: number;
}
export interface UploadInfo {
  ready: boolean;
  folder: string;
  free: number;
  max_bytes: number;
  synced: boolean;
  folders: string[];
  chunk_bytes: number;
}
export interface AppLog {
  time: number;
  level: string;
  text: string;
}

export const tz = -new Date().getTimezoneOffset();

export async function get<T>(path: string): Promise<T> {
  const r = await fetch("api/" + path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export async function post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const r = await fetch("api/" + path, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export function thumbUrl(name: string): string {
  return "api/thumb?path=" + encodeURIComponent(name);
}

export interface FileInfo {
  name: string;
  exists: boolean;
  kind: "photo" | "video";
  size: number | null;
  modified: number | null;
  status: string;
  account: string;
  updated: number | null;
  error: string;
  attempts: number;
  max_attempts: number;
  sha1: string;
  google_url: string;
  upload_ms: number | null;
  history: { time: number; kind: string; text: string }[];
  previewable: boolean;
  playable: boolean;
}

export function mediaUrl(name: string, download = false): string {
  return `api/media?path=${encodeURIComponent(name)}${download ? "&download=1" : ""}`;
}

export function previewUrl(name: string): string {
  return "api/preview?path=" + encodeURIComponent(name);
}

export interface Job {
  kind: "library" | "storage" | "dates" | "copy";
  account: string;
  /** Copies: the destination account. */
  to?: string;
  name?: string;
  step?: string;
  done?: number;
  total?: number;
}

export interface DownloadItem {
  id: number;
  account: string;
  name: string;
  kind: "photo" | "video";
  size: number;
  taken: number | null;
  added: number;
}
export interface DownloadsReport {
  folder: string;
  accounts: Record<string, { photos: number; videos: number; bytes: number }>;
  items: DownloadItem[];
}
