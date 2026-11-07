// The file types the server backs up (PHOTO_EXTS and VIDEO_EXTS in backend/sync.py). The server
// keeps a file by its extension, so the browser checks the same list before sending anything.
const UPLOADABLE =
  /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|dng|cr[23]|nef|arw|raf|orf|rw2|srw|pef|mp4|mov|m4v|3gp|3g2|avi|mkv|webm|mts|m2ts|wmv|mpe?g)$/i;
const VIDEO = /\.(mp4|mov|m4v|3gp|3g2|avi|mkv|webm|mts|m2ts|wmv|mpe?g)$/i;

export function uploadable(name: string): boolean {
  return UPLOADABLE.test(name);
}

export function videoName(name: string): boolean {
  return VIDEO.test(name);
}
