export interface DetectedImagePath {
	/** Exact substring as it appears in the editor text (used for tracking/removal). */
	raw: string;
	/** Filesystem path with surrounding quotes stripped and shell escapes resolved. */
	path: string;
}

const IMAGE_EXT = "(?:png|jpe?g|gif|webp)";
// A bare path segment is either a backslash-escaped character (e.g. "\ " for a
// space in a dragged path) or any character that is not whitespace or a
// shell/glob metacharacter.
const BARE_PATH = `(?:~/|\\.\\.?/|/)(?:\\\\.|[^\\s:*?"<>|])*\\.${IMAGE_EXT}(?=\\s|$)`;
// A double-quoted path may contain spaces verbatim; terminals quote dragged
// paths this way as an alternative to backslash-escaping.
// The closing quote must sit at a token boundary: it may be followed by
// whitespace, end of text, or punctuation (e.g. a comma), but not by another
// filename-ish character, so a trailing `"x.png"junk` does not match.
const QUOTE_END = "(?![A-Za-z0-9._-])";
const DOUBLE_QUOTED_PATH = `"(?:\\\\.|[^"\\\\])*\\.${IMAGE_EXT}"${QUOTE_END}`;
const SINGLE_QUOTED_PATH = `'(?:\\\\.|[^'\\\\])*\\.${IMAGE_EXT}'${QUOTE_END}`;
const IMAGE_PATH_RE = new RegExp(
	`${DOUBLE_QUOTED_PATH}|${SINGLE_QUOTED_PATH}|${BARE_PATH}`,
	"gi",
);

/** Strip surrounding quotes and resolve shell-style backslash escapes. */
function normalizePath(raw: string): string {
	let value = raw;
	const quoted =
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"));
	if (quoted) {
		value = value.slice(1, -1);
	}
	return value.replace(/\\(.)/g, "$1");
}

export function extractImagePaths(text: string): DetectedImagePath[] {
	const re = new RegExp(IMAGE_PATH_RE.source, IMAGE_PATH_RE.flags);
	const results: DetectedImagePath[] = [];
	for (const match of text.matchAll(re)) {
		const raw = match[0];
		results.push({ raw, path: normalizePath(raw) });
	}
	return results;
}
