import path from "node:path";
import type { ImageContent, ContentBlock } from "./content.ts";
import { ImageGallery, type GalleryImage, type GalleryTheme } from "./image-gallery.ts";
import { extractImagePaths } from "./image-paths.ts";
import { PREVIEW_MAX_BYTES } from "./preview-resize.ts";
import { upgradeScreenshotToolResult } from "./tool-result-upgrader.ts";
import { debugLog } from "./debug.ts";

// ── Types ──────────────────────────────────────────────────

type TrackedImage = {
	filePath: string;
	/** Full-resolution image attached to the submitted message. */
	image: ImageContent;
	/** Small PNG thumbnail used only for the inline gallery preview. */
	previewImage?: ImageContent;
	label: string;
};

export type ExtensionDeps = {
	readImageContentFromPathAsync: (
		filePath: string,
	) => Promise<ImageContent | null>;
	maybeResizeImage?: (image: ImageContent) => Promise<ImageContent>;
	loadImageContentFromPath: (
		filePath: string,
	) => Promise<ImageContent | null>;
	/** Downscale the full-size attachment below the provider's per-image byte
	 * limit before it is submitted. Absent means submit the image unchanged. */
	resizeForSubmission?: (image: ImageContent) => Promise<ImageContent>;
};

type PiLike = {
	on(event: string, handler: (...args: any[]) => any): void;
	sendUserMessage(
		content: string | ContentBlock[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
	registerEntryRenderer(
		customType: string,
		renderer: (entry: any, options: any, theme: any) => unknown,
	): void;
	appendEntry(customType: string, data?: unknown): void;
};

type CtxLike = {
	cwd: string;
	isIdle(): boolean;
	/** False where pi shows no transcript (print and JSON modes). */
	hasUI?: boolean;
	ui: {
		setWidget(
			key: string,
			content:
				| string[]
				| ((tui: any, theme: any) => any)
				| undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		getEditorText(): string;
		setEditorText(text: string): void;
		/** Show a transient status line (e.g. "✓ Prompt sent"). Provided by pi-core's ExtensionUIContext. */
		theme: any;
	};
};

/** Event shape for the "input" event from pi. */
type InputEvent = {
	text: string;
	images?: ImageContent[];
};

/** Discriminated union for input handler return values. */
type InputResult =
	| { action: "continue" }
	| { action: "handled" }
	| { action: "transform"; text: string; images: ImageContent[] };

/** Event shape for the "message_start" event from pi. */
type MessageStartEvent = {
	message: { role: string; content: string | ContentBlock[] };
};

/** Re-export for tool_result event typing. */
type ToolResultEvent = import("./tool-result-upgrader.ts").ToolResultEventLike;

// ── Constants ──────────────────────────────────────────────

const WIDGET_KEY = "image-preview";
const POLL_INTERVAL_MS = 250;
/** Session entry that keeps submitted thumbnails in the transcript. */
const ATTACHMENT_ENTRY = "image-preview-attachment";

/** Produce a label from an image path — just the filename. */
function trimImageLabel(filePath: string): string {
	return path.basename(filePath);
}

function galleryTheme(theme: any): GalleryTheme {
	return {
		accent: (s: string) => theme.fg("accent", s),
		muted: (s: string) => theme.fg("muted", s),
		dim: (s: string) => theme.fg("dim", s),
		bold: (s: string) => theme.bold(s),
	};
}

// ── Extension ──────────────────────────────────────────────

export function registerImagePreviewExtension(
	pi: PiLike,
	deps: ExtensionDeps,
): void {
	let tracked: Map<string, TrackedImage> = new Map();
	let gallery: ImageGallery | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let latestCtx: CtxLike | null = null;
	/** Thumbnails previewed for the last submission, until their user message starts. */
	let submitted: GalleryImage[] = [];

	// ── Helpers ────────────────────────────────────────────

	function refreshWidget(ctx: CtxLike): void {
		if (tracked.size === 0) {
			if (gallery) {
				gallery.dispose();
				gallery = null;
			}
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const galleryImages: GalleryImage[] = [...tracked.values()].map((t) => {
			const preview = t.previewImage ?? t.image;
			return {
				data: preview.data,
				mimeType: preview.mimeType,
				label: t.label,
			};
		});

		// Dispose the previous gallery to free kitty image resources before replacement
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: any, theme: any) => {
				gallery = new ImageGallery(galleryTheme(theme));
				gallery.setImages(galleryImages);
				return gallery;
			},
			{ placement: "aboveEditor" },
		);
	}

	function resetDraft(ctx: CtxLike): void {
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}
		tracked = new Map();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/**
	 * Track image paths from a text snapshot.
	 * Track new ones, remove ones that are no longer in the text.
	 * Async to avoid blocking the event loop with file I/O.
	 */
	async function syncTrackedImagesFromText(text: string, ctx: CtxLike): Promise<void> {
		if (!text) {
			if (tracked.size > 0) {
				tracked = new Map();
				refreshWidget(ctx);
			}
			return;
		}

		// Find all image paths currently in the text. Handles plain, relative,
		// home-relative, backslash-escaped, and quoted paths (typed, pasted, or
		// inserted by drag-and-drop). Track by the exact editor substring (`raw`)
		// so removal and submit matching stay in sync with the visible text, but
		// read the file and build the label from the resolved `path`.
		const detected = extractImagePaths(text);
		const currentPaths = new Set<string>();

		let changed = false;

		for (const { raw, path: filePath } of detected) {
			currentPaths.add(raw);

			// Already tracked?
			if (tracked.has(raw)) continue;

			// New path — try to load it (async to avoid blocking event loop)
			const image = await deps.readImageContentFromPathAsync(filePath);
			if (!image) continue;

			tracked.set(raw, {
				filePath,
				image,
				label: trimImageLabel(filePath),
			});
			changed = true;

			// Build the small PNG preview thumbnail in the background so a large
			// image renders instead of overflowing kitty/tmux transmission. The
			// full image stays in `entry.image` for the message attachment.
			if (deps.maybeResizeImage) {
				const entry = tracked.get(raw)!;
				void deps.maybeResizeImage(image).then((resized) => {
					// Guard against the entry having been removed while resize was in-flight
					if (tracked.has(raw) && tracked.get(raw) === entry) {
						entry.previewImage = resized;
						if (latestCtx) refreshWidget(latestCtx);
					}
				}).catch((err) => {
					debugLog(`Failed to resize image ${filePath}`, err);
				});
			}
		}

		// Remove tracked images whose paths are no longer in the text
		for (const trackedPath of tracked.keys()) {
			if (!currentPaths.has(trackedPath)) {
				tracked.delete(trackedPath);
				changed = true;
			}
		}

		if (changed) {
			refreshWidget(ctx);
		}
	}

	/**
	 * Scan editor text for image paths.
	 */
	async function scanEditorText(ctx: CtxLike): Promise<void> {
		let text: string;
		try {
			text = ctx.ui.getEditorText();
		} catch (err) {
			debugLog("Failed to get editor text", err);
			return;
		}
		await syncTrackedImagesFromText(text, ctx);
	}

	function startPolling(): void {
		stopPolling();
		pollTimer = setInterval(() => {
			if (!latestCtx) return;
			scanEditorText(latestCtx).catch((err) => {
				debugLog("Error during editor text scan", err);
			});
		}, POLL_INTERVAL_MS);
		// Don't let the poll timer keep the Node event loop alive.
		// In non-interactive modes (e.g. `pi --print`), the process must be
		// able to exit once work is done — an active interval would block exit.
		if (typeof pollTimer.unref === "function") {
			pollTimer.unref();
		}
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// ── Event handlers ─────────────────────────────────────

	// Clean up resources when the process exits
	const cleanup = (): void => {
		stopPolling();
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	pi.on("session_start", async (_event: unknown, ctx: CtxLike) => {
		latestCtx = ctx;
		resetDraft(ctx);
		startPolling();
	});

	pi.on("session_switch", async (_event: unknown, ctx: CtxLike) => {
		latestCtx = ctx;
		resetDraft(ctx);
		startPolling();
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx: CtxLike) => {
		latestCtx = ctx;
		return upgradeScreenshotToolResult(
			event,
			ctx.cwd,
			deps.loadImageContentFromPath,
		);
	});

	// On submit: strip image paths from text, attach actual images
	pi.on("input", async (event: InputEvent, ctx: CtxLike): Promise<InputResult> => {
		latestCtx = ctx;

		const fullText = (event.text || "").trim();

		// Don't transform commands or shell escapes
		if (fullText.startsWith("/") || fullText.trimStart().startsWith("!")) {
			return { action: "continue" };
		}

		// Submit may happen before the 250ms poller has seen a freshly pasted
		// path. Only when the submitted text references a path the poller has
		// not tracked yet do we pay for an async sync — otherwise return using
		// the cached entries so pi transcribes the user message as fast as a
		// normal text prompt (the await would gate message_start in pi-core).
		const detected = extractImagePaths(fullText);
		const hasUntracked = detected.some(({ raw }) => !tracked.has(raw));
		if (hasUntracked) {
			await syncTrackedImagesFromText(fullText, ctx);
		}

		if (tracked.size === 0) {
			return { action: "continue" };
		}

		// Collect images for all tracked paths in the submitted text, resizing
		// them concurrently while preserving their order in the submitted text.
		const matched = [...tracked.entries()]
			.filter(([trackedPath]) => fullText.includes(trackedPath))
			.map(([, entry]) => entry);
		const usedImages: ImageContent[] = await Promise.all(
			matched.map((entry) =>
				deps.resizeForSubmission
					? deps.resizeForSubmission(entry.image)
					: Promise.resolve(entry.image),
			),
		);

		if (usedImages.length === 0) {
			return { action: "continue" };
		}

		// pi draws a user message from its text only; the thumbnails already
		// previewed above the editor are kept as a session entry instead.
		const thumbnails: GalleryImage[] = matched.flatMap(
			({ label, previewImage }) =>
				previewImage && previewImage.data.length <= PREVIEW_MAX_BYTES
					? [{ data: previewImage.data, mimeType: previewImage.mimeType, label }]
					: [],
		);

		// Clear state
		resetDraft(ctx);
		submitted = ctx.hasUI === false ? [] : thumbnails;

		// Keep the original text as-is (paths stay visible in chat),
		// just attach the actual image data alongside
		return {
			action: "transform",
			text: fullText,
			images: [...(event.images ?? []), ...usedImages],
		};
	});

	// The entry is appended when pi starts that user message, so it lands right
	// above the message even for a queued submission.
	// shortcut: pi places an entry appended mid-stream above the streaming
	// reply, so a steering submission lands one block too high.
	// SAFETY: the renderer runs for entries this extension wrote.
	const galleries = new WeakMap<object, ImageGallery>();
	pi.registerEntryRenderer(ATTACHMENT_ENTRY, (entry, _options, theme) => {
		// pi rebuilds chat components on invalidate; one gallery per entry keeps
		// its kitty image ids stable across rebuilds.
		let entryGallery = galleries.get(entry);
		if (!entryGallery) {
			entryGallery = new ImageGallery(galleryTheme(theme));
			entryGallery.setImages(entry.data?.images ?? []);
			galleries.set(entry, entryGallery);
		}
		return entryGallery;
	});
	pi.on("message_start", (event: MessageStartEvent, ctx: CtxLike) => {
		if (event.message.role !== "user") return;
		const thumbnails = submitted;
		submitted = [];
		const sent = Array.isArray(event.message.content) &&
			event.message.content.some((block) => block.type === "image");
		// The message owns them; without images it never carried them (another
		// extension replaced the input), so they are dropped either way.
		if (thumbnails.length && sent && ctx.hasUI !== false) {
			pi.appendEntry(ATTACHMENT_ENTRY, { images: thumbnails });
		}
	});
}
