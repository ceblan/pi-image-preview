import {
	Container,
	getCapabilities,
	Image,
	setCapabilities,
	type TerminalCapabilities,
} from "@earendil-works/pi-tui";
import {
	detectImageProtocol,
	imageEpoch,
	isInTmuxSession,
	watchTmuxClients,
} from "./image-protocol.ts";
import {
	allocateImageId,
	buildPlaceholderRow,
	transmitImageWithPlaceholder,
} from "./kitty-placeholder.ts";

/**
 * Draws chat images (tool results, sent attachments) inline inside tmux, the
 * way pi draws them directly in kitty, Ghostty, WezTerm or Rex.
 *
 * pi-tui reports `images: null` inside tmux because direct kitty placements
 * are not tied to a pane, and pi then skips creating Image components at all.
 * While every client viewing this pane speaks kitty, this module sets
 * `images: "kitty"` so pi builds its images exactly as in kitty or Rex, and
 * patches Image.render to swap the direct placement for Unicode placeholders,
 * which tmux stores as pane text. When another client views the pane (a phone
 * over SSH), pi's own capabilities come back and images fall back to text.
 * Outside tmux, or when pi-tui already draws images, nothing changes.
 */

type ImageInternals = {
	base64Data: string;
	mimeType: string;
	pngData?: string;
	cachedLines?: string[];
	cachedWidth?: number;
};

type InlineState = {
	key: string;
	lines: string[];
	imageId: number;
};

type Renderable = { render(width: number): string[] };
type RenderFn = (this: Renderable, width: number) => string[];
type Redrawable = {
	invalidate(): void;
	requestRender(force?: boolean): void;
	terminal: unknown;
};

const PATCHED = Symbol.for("pi-image-preview.inline-images");
const states = new WeakMap<object, InlineState>();

/** Reads `c=` and `r=` from the kitty sequence pi-tui produced. */
export function parsePlacementSize(
	sequence: string,
): { columns: number; rows: number } | null {
	const columns = /[_,;]c=(\d+)/.exec(sequence);
	const rows = /[_,;]r=(\d+)/.exec(sequence);
	if (!columns || !rows) return null;
	return { columns: Number(columns[1]), rows: Number(rows[1]) };
}

export function placeholderLines(
	imageId: number,
	columns: number,
	rows: number,
): string[] {
	return Array.from({ length: rows }, (_, row) =>
		buildPlaceholderRow(imageId, row, columns),
	);
}

function renderDirect(
	image: ImageInternals,
	original: RenderFn,
	self: Renderable,
	width: number,
): string[] {
	const lines = original.call(self, width);
	// pi-tui's cache now holds direct-placement lines; drop them so its own
	// path never returns them after the override ends.
	image.cachedLines = undefined;
	image.cachedWidth = undefined;
	return lines;
}

function renderInline(
	this: Renderable,
	original: RenderFn,
	width: number,
): string[] {
	// SAFETY: only installed on Image.prototype; pi-tui's Image keeps these as
	// TypeScript-private fields, which are plain properties at runtime.
	const image = this as unknown as ImageInternals;
	const key = `${width}:${imageEpoch()}`;
	const previous = states.get(this);
	if (previous?.key === key) return previous.lines;

	const direct = renderDirect(image, original, this, width);
	const size = direct[0] ? parsePlacementSize(direct[0]) : null;
	const data = image.mimeType === "image/png" ? image.base64Data : image.pngData;
	// No size means pi-tui fell back to text (for example, no PNG converter).
	if (!size || !data) return direct;

	const imageId = sendOnce(data, size.columns, size.rows, previous?.imageId);
	const lines = placeholderLines(imageId, size.columns, size.rows);
	states.set(this, { key, lines, imageId });
	return lines;
}

type Sent = { imageId: number; epoch: number; columns: number; rows: number };

/**
 * Image data already in kitty, by base64 payload. pi rebuilds its Image
 * components on every invalidate, so without this each redraw would send
 * every transcript image again under a new ID and leave the old ones behind.
 */
const sent = new Map<string, Sent>();

function sendOnce(
	data: string,
	columns: number,
	rows: number,
	fallbackId: number | undefined,
): number {
	const epoch = imageEpoch();
	const known = sent.get(data);
	if (
		known &&
		known.epoch === epoch &&
		known.columns === columns &&
		known.rows === rows
	) {
		return known.imageId;
	}
	// Re-sending under the same ID replaces the image in kitty.
	const imageId = known?.imageId ?? fallbackId ?? allocateImageId();
	transmitImageWithPlaceholder(data, imageId, columns, rows);
	sent.set(data, { imageId, epoch, columns, rows });
	return imageId;
}

// ── Redraw on client change ────────────────────────────────

let tui: Redrawable | undefined;

/**
 * Grabs the TUI instance on its next frame, then restores Container.render.
 * Returns a function that restores it early if no frame was drawn.
 */
function captureTui(): () => void {
	if (tui) return () => {};
	// SAFETY: Container declares render(width): string[]; this only widens `this`.
	const proto = Container.prototype as unknown as { render: RenderFn };
	const original = proto.render;
	const capture = function (this: Renderable, width: number) {
		// SAFETY: fields are checked below before the value is kept.
		const candidate = this as unknown as Partial<Redrawable>;
		if (
			candidate.terminal &&
			typeof candidate.requestRender === "function" &&
			typeof candidate.invalidate === "function"
		) {
			tui = candidate as Redrawable;
			proto.render = original;
		}
		return original.call(this, width);
	};
	proto.render = capture;
	return () => {
		if (proto.render === capture) proto.render = original;
	};
}

/**
 * pi decides whether a tool result gets an Image component when it builds the
 * result, and rebuilds it on invalidate. Invalidating the whole tree therefore
 * adds images that were skipped while a non-kitty client was viewing, and
 * drops them when one arrives.
 */
function redraw(): void {
	tui?.invalidate();
	tui?.requestRender(true);
}

// ── Capability override ────────────────────────────────

/** pi-tui's own capabilities, saved while the override is active. */
let saved: TerminalCapabilities | undefined;

function overriding(): boolean {
	return saved !== undefined;
}

/** Turns the kitty override on or off to match the current tmux viewers. */
function syncCapabilities(): void {
	const wanted = detectImageProtocol() === "kitty";
	// pi resets its capability cache when terminal settings change, which
	// drops the override, so re-apply it whenever it is missing.
	if (wanted && getCapabilities().images !== "kitty") {
		saved ??= getCapabilities();
		setCapabilities({ ...getCapabilities(), images: "kitty" });
	} else if (!wanted && saved) {
		setCapabilities(saved);
		saved = undefined;
	}
}

// ── Install ────────────────────────────────────────────────

export function installInlineImages(): () => void {
	// pi-tui already draws images here (kitty, Ghostty, Rex outside tmux).
	if (getCapabilities().images || !isInTmuxSession()) return () => {};
	// SAFETY: Image declares render(width): string[]; the symbol slot is ours.
	const proto = Image.prototype as unknown as Renderable & {
		[PATCHED]?: RenderFn;
	};
	if (proto[PATCHED]) return () => {};
	const original = proto.render as RenderFn;
	proto[PATCHED] = original;
	proto.render = function (this: Renderable, width: number) {
		// Not overriding means pi's own setting applies: either a native image
		// terminal, or a non-kitty viewer (for example, a phone over SSH), where
		// pi draws its text fallback. No delete is sent in that case, since it
		// would reach the non-kitty client too; kitty evicts unused images on its
		// own, and a new epoch resends them when kitty is the only viewer again.
		if (!overriding()) return original.call(this, width);
		return renderInline.call(this, original, width);
	};

	syncCapabilities();
	const stopCapture = captureTui();
	const stopWatching = watchTmuxClients(() => {
		syncCapabilities();
		redraw();
	});
	return () => {
		stopWatching();
		stopCapture();
		if (saved) setCapabilities(saved);
		saved = undefined;
		proto.render = original;
		delete proto[PATCHED];
		sent.clear();
		redraw();
	};
}
