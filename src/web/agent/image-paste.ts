// Adapted from cube-computer: packages/components/src/Terminal/image-paste.ts (bytesToBase64 only)

/** Chunked btoa: one String.fromCharCode(...bytes) call over megabytes
 * of screenshot overflows the argument stack. */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000;
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}
