import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	getCapabilities: () => ({ images: null }),
	getImageDimensions: () => null,
	calculateImageRows: () => 0,
	getCellDimensions: () => ({ widthPx: 0, heightPx: 0 }),
}));

import { registerImagePreviewExtension } from "../src/extension-runtime.ts";
import type { ImageContent } from "../src/content.ts";

type Handler = (...args: any[]) => any;

function makeHarness(deps: any) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		sendUserMessage: vi.fn(),
	};
	const ctx = {
		cwd: "/tmp",
		isIdle: () => true,
		ui: {
			setWidget: vi.fn(),
			getEditorText: vi.fn(() => ""),
			setEditorText: vi.fn(),
			theme: {},
		},
	};
	registerImagePreviewExtension(pi as any, deps);
	return { handlers, ctx };
}

const png: ImageContent = {
	type: "image",
	data: "ZmFrZS1wbmc=",
	mimeType: "image/png",
};

describe("extension input handling", () => {
	it("attaches a just-submitted image path even when polling has not tracked it yet", async () => {
		const reads: string[] = [];
		const readImage = async (filePath: string) => {
			reads.push(filePath);
			return filePath === "/tmp/pi-clipboard-race.png" ? png : null;
		};
		const { handlers, ctx } = makeHarness({
			readImageContentFromPathAsync: readImage,
			loadImageContentFromPath: readImage,
		});

		const result = await handlers.get("input")!(
			{ text: "Explain /tmp/pi-clipboard-race.png" },
			ctx,
		);

		expect(reads).toEqual(["/tmp/pi-clipboard-race.png"]);
		expect(result).toEqual({
			action: "transform",
			text: "Explain /tmp/pi-clipboard-race.png",
			images: [png],
		});
	});

	it("does not attach images for slash commands", async () => {
		const reads: string[] = [];
		const readImage = async (filePath: string) => {
			reads.push(filePath);
			return png;
		};
		const { handlers, ctx } = makeHarness({
			readImageContentFromPathAsync: readImage,
			loadImageContentFromPath: readImage,
		});

		const result = await handlers.get("input")!(
			{ text: "/open /tmp/pi-clipboard-race.png" },
			ctx,
		);

		expect(reads).toEqual([]);
		expect(result).toEqual({ action: "continue" });
	});

	it("resizes a just-submitted image path the poller has not tracked yet", async () => {
		const resizedImage = { ...png, data: "U01BTEw=" };
		const resizeForSubmission = vi.fn(async () => resizedImage);
		const { handlers, ctx } = makeHarness({
			readImageContentFromPathAsync: vi.fn(async () => png),
			loadImageContentFromPath: vi.fn(async () => null),
			resizeForSubmission,
		});

		const result = await handlers.get("input")!(
			{ text: "Explain /tmp/pi-clipboard-race.png", images: [] },
			ctx,
		);

		expect(result).toEqual({
			action: "transform",
			text: "Explain /tmp/pi-clipboard-race.png",
			images: [resizedImage],
		});
		expect(resizeForSubmission).toHaveBeenCalledTimes(1);
		expect(resizeForSubmission).toHaveBeenCalledWith(png);
	});
});

describe("submit attachment resizing", () => {
	it("attaches the downscaled image when a tracked attachment is oversized", async () => {
		vi.useFakeTimers();
		try {
			const rawImage = {
				type: "image" as const,
				data: "RAW",
				mimeType: "image/png",
			};
			const resizedImage = {
				type: "image" as const,
				data: "SMALL",
				mimeType: "image/png",
			};
			const resizeForSubmission = vi.fn(async () => resizedImage);
			const deps = {
				readImageContentFromPathAsync: vi.fn(async () => rawImage),
				loadImageContentFromPath: vi.fn(async () => null),
				resizeForSubmission,
			};
			const { handlers, ctx } = makeHarness(deps);
			ctx.ui.getEditorText = vi.fn(() => "check /tmp/big.png");

			await handlers.get("session_start")!(undefined, ctx);
			await vi.advanceTimersByTimeAsync(300);

			const result = await handlers.get("input")!(
				{ text: "check /tmp/big.png", images: [] },
				ctx,
			);

			expect(result.action).toBe("transform");
			expect(result.images).toEqual([resizedImage]);
			expect(resizeForSubmission).toHaveBeenCalledWith(rawImage);
		} finally {
			vi.useRealTimers();
		}
	});

	it("resizes multiple oversized attachments concurrently and preserves order", async () => {
		const rawA = {
			type: "image" as const,
			data: "RAW_A",
			mimeType: "image/png",
		};
		const rawB = {
			type: "image" as const,
			data: "RAW_B",
			mimeType: "image/png",
		};
		const byPath: Record<string, any> = {
			"/tmp/a.png": rawA,
			"/tmp/b.png": rawB,
		};
		const started: string[] = [];
		let releaseA!: () => void;
		const aGate = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const resizeForSubmission = vi.fn(async (img: any) => {
			started.push(img.data);
			if (img.data === "RAW_A") await aGate;
			return {
				type: "image" as const,
				data: `${img.data}_SMALL`,
				mimeType: img.mimeType,
			};
		});
		const deps = {
			readImageContentFromPathAsync: vi.fn(
				async (p: string) => byPath[p] ?? null,
			),
			loadImageContentFromPath: vi.fn(async () => null),
			resizeForSubmission,
		};
		const { handlers, ctx } = makeHarness(deps);
		const text = "see /tmp/a.png and /tmp/b.png";
		ctx.ui.getEditorText = vi.fn(() => text);

		await handlers.get("session_start")!(undefined, ctx);
		await new Promise((r) => setTimeout(r, 300));

		const submit = handlers.get("input")!({ text, images: [] }, ctx);
		await Promise.resolve();
		await Promise.resolve();

		// Both resizes must start even while the first is still pending.
		expect(started.length === 2).toBe(true);

		releaseA();
		const result = await submit;
		expect(result.action).toBe("transform");
		expect(result.images).toEqual([
			{ type: "image", data: "RAW_A_SMALL", mimeType: "image/png" },
			{ type: "image", data: "RAW_B_SMALL", mimeType: "image/png" },
		]);
	});

	it("attaches the original image when no submission resizer is provided", async () => {
		vi.useFakeTimers();
		try {
			const rawImage = {
				type: "image" as const,
				data: "RAW",
				mimeType: "image/png",
			};
			const deps = {
				readImageContentFromPathAsync: vi.fn(async () => rawImage),
				loadImageContentFromPath: vi.fn(async () => null),
			};
			const { handlers, ctx } = makeHarness(deps);
			ctx.ui.getEditorText = vi.fn(() => "check /tmp/big.png");

			await handlers.get("session_start")!(undefined, ctx);
			await vi.advanceTimersByTimeAsync(300);

			const result = await handlers.get("input")!(
				{ text: "check /tmp/big.png", images: [] },
				ctx,
			);

			expect(result.action).toBe("transform");
			expect(result.images).toEqual([rawImage]);
		} finally {
			vi.useRealTimers();
		}
	});
});
