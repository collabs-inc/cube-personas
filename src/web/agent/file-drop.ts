// Adapted from cube-computer: packages/components/src/Terminal/file-drop.ts (dropContents only)
/**
 * The client-side half of dragging a local file into a terminal whose
 * pty runs on ANOTHER machine. A local session needs none of this — its
 * pty can already open the path the drop carries — but a cloud session
 * cannot see this filesystem at all, so the bytes have to travel and the
 * path typed at the pty has to be the one they landed on over there.
 *
 * Deliberately DOM-light: the two structural interfaces below are what a
 * real `DataTransfer` satisfies, and are also what a test can hand in
 * without a DOM, the same trade `image-paste.ts` makes for clipboards.
 *
 * `dropContents` must be called SYNCHRONOUSLY from the drop handler —
 * a `DataTransfer` is emptied once the event finishes dispatching, so
 * anything read after the first `await` is gone.
 */

interface DropItemLike {
	readonly kind: string;
	webkitGetAsEntry?: () => { readonly isDirectory: boolean } | null;
	getAsFile: () => File | null;
}

interface DataTransferLike {
	readonly items?: ArrayLike<DropItemLike> | null;
	readonly files?: ArrayLike<File> | null;
}

export interface DropContents {
	files: File[];
	/** Folders are refused rather than walked — see `sendDroppedFiles`'s
	 *  caller, which names them so the user is not left wondering why
	 *  the drop did nothing. */
	folderNames: string[];
}

/**
 * Reads a drop into files and refused folders. Directory detection goes
 * through `webkitGetAsEntry`, not a path stat: it is synchronous, and it
 * is the only check that works in a browser tab, where a drop carries no
 * path to stat in the first place.
 */
export function dropContents(data: DataTransferLike | null | undefined): DropContents {
	const files: File[] = [];
	const folderNames: string[] = [];
	const items = data?.items;
	if (items && items.length > 0) {
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (!item || item.kind !== "file") continue;
			const file = item.getAsFile();
			if (item.webkitGetAsEntry?.()?.isDirectory === true) {
				folderNames.push(file?.name ?? "folder");
				continue;
			}
			if (file) files.push(file);
		}
		return { files, folderNames };
	}
	// No `items`: there is no synchronous way to spot a directory, so
	// everything reads as a file. Better than dropping the gesture.
	const list = data?.files;
	if (list) {
		for (let i = 0; i < list.length; i++) {
			const file = list[i];
			if (file) files.push(file);
		}
	}
	return { files, folderNames };
}
