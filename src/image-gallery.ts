import {
	type Component,
	getImageDimensions,
	calculateImageRows,
	getCellDimensions,
} from "@earendil-works/pi-tui";
import { detectImageProtocol, imageEpoch } from "./image-protocol.ts";
import {
	allocateImageId,
	buildPlaceholderRow,
	deleteImage,
	transmitImageWithPlaceholder,
} from "./kitty-placeholder.ts";

export interface GalleryTheme {
	accent: (s: string) => string;
	muted: (s: string) => string;
	dim: (s: string) => string;
	bold: (s: string) => string;
}

export interface GalleryImage {
	data: string; // base64
	mimeType: string;
	label: string;
}

const THUMB_MAX_WIDTH = 25;
const THUMB_MAX_ROWS = 15; // cap height so tall images don't overflow the terminal
const GAP = 2; // columns between images

// ── Gallery Component ──────────────────────────────────────

/**
 * Renders image thumbnails above the editor using kitty's Unicode
 * placeholder protocol. Images are part of the text buffer, so
 * tmux manages them per-pane — no ghosting across panes.
 */
export class ImageGallery implements Component {
	private images: GalleryImage[] = [];
	private theme: GalleryTheme;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private cachedEpoch?: number;
	private activeImageIds: number[] = [];

	constructor(theme: GalleryTheme) {
		this.theme = theme;
	}

	setImages(images: GalleryImage[]): void {
		this.images = images;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	dispose(): void {
		this.deleteActiveImages(detectImageProtocol());
	}

	/** Kitty commands would reach non-kitty viewers as junk; only forget IDs then. */
	private deleteActiveImages(imageProtocol: string | null): void {
		if (imageProtocol === "kitty") {
			for (const id of this.activeImageIds) deleteImage(id);
		}
		this.activeImageIds = [];
	}

	render(width: number): string[] {
		// A new epoch means a client joined that never received the image data.
		if (
			this.cachedLines &&
			this.cachedWidth === width &&
			this.cachedEpoch === imageEpoch()
		) {
			return this.cachedLines;
		}
		this.cachedEpoch = imageEpoch();

		const imageProtocol = detectImageProtocol();
		// Delete previous images before re-rendering
		this.deleteActiveImages(imageProtocol);

		if (this.images.length === 0) {
			this.cachedLines = [];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const lines: string[] = [];

		// Header
		const count = this.images.length;
		const headerText =
			count === 1
				? " 📎 1 image attached"
				: ` 📎 ${count} images attached`;
		lines.push(this.theme.accent(headerText));

		if (imageProtocol === "kitty") {
			this.renderKittyHorizontal(lines, width);
		} else {
			this.renderTextFallback(lines);
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private renderKittyHorizontal(lines: string[], width: number): void {
		// Calculate per-image thumb width so they all fit side by side
		const available = width - 2; // padding
		const totalGaps = Math.max(0, this.images.length - 1) * GAP;
		const thumbWidth = Math.min(
			THUMB_MAX_WIDTH,
			Math.floor((available - totalGaps) / this.images.length),
		);

		if (thumbWidth < 4) {
			// Too narrow for horizontal, fall back to text
			this.renderTextFallback(lines);
			return;
		}

		// Prepare each image: transmit data, calculate rows
		const imageInfos: { imageId: number; rows: number; cols: number }[] = [];

		for (const img of this.images) {
			// getImageDimensions returns null for corrupt or unrecognised image data;
			// fall back to a common aspect ratio so the thumbnail still renders.
			const dims = getImageDimensions(img.data, img.mimeType) || {
				widthPx: 800,
				heightPx: 600,
			};

			const rows = Math.min(
				calculateImageRows(dims, thumbWidth, getCellDimensions()),
				THUMB_MAX_ROWS,
			);
			const imageId = allocateImageId();
			this.activeImageIds.push(imageId);

			transmitImageWithPlaceholder(img.data, imageId, thumbWidth, rows);
			imageInfos.push({ imageId, rows, cols: thumbWidth });
		}

		const maxRows = Math.max(...imageInfos.map((i) => i.rows));

		// Build horizontal rows: each line has placeholder chars for all images side by side
		for (let row = 0; row < maxRows; row++) {
			let line = " ";
			for (let i = 0; i < this.images.length; i++) {
				const info = imageInfos[i];

				if (row < info.rows) {
					// Output placeholder chars for this image at this row
					line += buildPlaceholderRow(info.imageId, row, info.cols);
				} else {
					// Image is shorter, pad with spaces
					line += " ".repeat(info.cols);
				}

				if (i < this.images.length - 1) {
					line += " ".repeat(GAP);
				}
			}
			lines.push(line);
		}

		// Label row beneath images — middle-truncate and center
		let labelLine = " ";
		for (let i = 0; i < this.images.length; i++) {
			const cols = imageInfos[i].cols;
			let label = this.images[i].label;

			// Middle-truncate: "pi-clipboard-044c...21ad4.png"
			if (label.length > cols) {
				const keep = cols - 1; // 1 char for …
				const head = Math.ceil(keep / 2);
				const tail = keep - head;
				label = label.slice(0, head) + "…" + label.slice(-tail);
			}

			// Center the label within the column width
			const totalPad = Math.max(0, cols - label.length);
			const leftPad = Math.floor(totalPad / 2);
			const rightPad = totalPad - leftPad;
			const padded = " ".repeat(leftPad) + label + " ".repeat(rightPad);
			labelLine += this.theme.dim(padded);

			if (i < this.images.length - 1) {
				labelLine += " ".repeat(GAP);
			}
		}
		lines.push(labelLine);
	}

	private renderTextFallback(lines: string[]): void {
		for (const img of this.images) {
			lines.push(
				this.theme.muted(`  ${img.label}`),
			);
		}
	}
}
