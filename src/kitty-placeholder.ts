/**
 * Kitty graphics protocol helpers shared by the attachment gallery and the
 * inline transcript images. Images are drawn with Unicode placeholders, which
 * tmux stores as ordinary text, so they stay with their pane.
 */

import { isInTmuxSession, noteImageTransmitted } from "./image-protocol.ts";

// Counter for kitty image IDs over the full 24-bit range (1–16,777,215) that
// kitty's true-color encoding supports. Counting avoids collisions inside one
// process; the random start keeps several pi processes sharing one kitty from
// all starting at 1 and overwriting each other's images.
let nextImageId = 1 + Math.floor(Math.random() * 0xfffffe);
export function allocateImageId(): number {
	const id = nextImageId;
	nextImageId = (nextImageId % 0xffffff) + 1; // wrap at 16M, skip 0
	return id;
}

// ── Kitty Unicode Placeholder Protocol ─────────────────────
// Instead of rendering pixels directly (which ghost across tmux panes),
// we transmit the image data and then output U+10EEEE placeholder
// characters with diacritics encoding row/col. Since these are just
// text characters, tmux manages them per-pane — images appear/disappear
// naturally when switching panes.
//
// Protocol:
// 1. Transmit image: ESC_G a=T,U=1,f=100,i=<id>,c=<cols>,r=<rows>,q=2; base64 ESC\
// 2. Print placeholder chars with foreground color set to image_id:
//    ESC[38;5;<id>m  <U+10EEEE><row_diac><col_diac> ... ESC[39m
//
// Diacritics: row 0 = U+0305, row 1 = U+030D, row 2 = U+030E, etc.
// See kitty docs rowcolumn-diacritics.txt

// Row/column diacritics from kitty's rowcolumn-diacritics.txt
// These are the combining characters used to encode row and column numbers
const ROW_COL_DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f,
	0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0353,
	0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368,
	0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483,
	0x0484, 0x0485, 0x0486, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
	0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
	0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
	0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0618, 0x0619,
	0x061a, 0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651,
	0x0652, 0x0653, 0x0654, 0x0655, 0x0656, 0x0657, 0x0658, 0x0659,
	0x065a, 0x065b, 0x065c, 0x065d, 0x065e, 0x065f, 0x0670, 0x06d6,
	0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0,
	0x06e1, 0x06e2, 0x06e3, 0x06e4, 0x06e7, 0x06e8, 0x06ea, 0x06eb,
	0x06ec, 0x06ed,
];

const PLACEHOLDER_CHAR = String.fromCodePoint(0x10EEEE);

function diacriticFor(n: number): string {
	if (n < ROW_COL_DIACRITICS.length) {
		return String.fromCodePoint(ROW_COL_DIACRITICS[n]);
	}
	// Fallback for very large values (shouldn't happen for thumbnails)
	return String.fromCodePoint(ROW_COL_DIACRITICS[0]);
}

/**
 * Wrap kitty APC sequences in DCS passthrough for tmux.
 */
function wrapForTmux(sequence: string): string {
	if (!isInTmuxSession()) return sequence;
	return sequence.replace(
		/\x1b_G([^\x1b]*)\x1b\\/g,
		(_match, content) =>
			`\x1bPtmux;\x1b\x1b_G${content}\x1b\x1b\\\x1b\\`,
	);
}

/**
 * Transmit image and create virtual placement using Unicode placeholder mode.
 * The image data is sent to kitty but NOT displayed directly.
 * Display happens via U+10EEEE placeholder characters.
 */
export function transmitImageWithPlaceholder(
	base64Data: string,
	imageId: number,
	columns: number,
	rows: number,
): void {
	// Transmit image + create virtual placement in one command
	// a=T: transmit and display, U=1: use unicode placeholders
	// q=2: suppress all responses (important in tmux)
	const CHUNK_SIZE = 4096;
	noteImageTransmitted();

	if (base64Data.length <= CHUNK_SIZE) {
		const seq = `\x1b_Ga=T,U=1,f=100,i=${imageId},c=${columns},r=${rows},q=2;${base64Data}\x1b\\`;
		process.stdout.write(wrapForTmux(seq));
	} else {
		// Chunked transfer
		let offset = 0;
		let isFirst = true;
		while (offset < base64Data.length) {
			const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
			const isLast = offset + CHUNK_SIZE >= base64Data.length;
			let seq: string;

			if (isFirst) {
				seq = `\x1b_Ga=T,U=1,f=100,i=${imageId},c=${columns},r=${rows},q=2,m=1;${chunk}\x1b\\`;
				isFirst = false;
			} else if (isLast) {
				seq = `\x1b_Gm=0;${chunk}\x1b\\`;
			} else {
				seq = `\x1b_Gm=1;${chunk}\x1b\\`;
			}

			process.stdout.write(wrapForTmux(seq));
			offset += CHUNK_SIZE;
		}
	}
}

/**
 * Delete a kitty image by ID.
 */
export function deleteImage(imageId: number): void {
	const seq = `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
	process.stdout.write(wrapForTmux(seq));
}

/**
 * Build a row of Unicode placeholder characters for the given image.
 * Uses foreground color to encode image_id, diacritics to encode row/col.
 */
export function buildPlaceholderRow(
	imageId: number,
	row: number,
	columns: number,
): string {
	// Set foreground color to image_id (using 24-bit true color for large IDs)
	const r = (imageId >> 16) & 0xff;
	const g = (imageId >> 8) & 0xff;
	const b = imageId & 0xff;
	const fgStart = imageId < 256
		? `\x1b[38;5;${imageId}m`
		: `\x1b[38;2;${r};${g};${b}m`;
	const fgEnd = `\x1b[39m`;

	let line = fgStart;

	// First cell: full diacritics (row + col)
	line += PLACEHOLDER_CHAR + diacriticFor(row) + diacriticFor(0);

	// Subsequent cells: no diacritics needed — kitty auto-increments
	// column index from the left neighbor's col diacritic
	for (let col = 1; col < columns; col++) {
		line += PLACEHOLDER_CHAR;
	}

	line += fgEnd;
	return line;
}

