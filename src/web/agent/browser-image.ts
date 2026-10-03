// Adapted from cube-computer: packages/shared/src/browser-image.ts
const BROWSER_PREVIEW_IMAGE = /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;

/** Image formats Chromium can display directly without a conversion step. */
export function isBrowserPreviewImage(path: string): boolean {
  return BROWSER_PREVIEW_IMAGE.test(path);
}
