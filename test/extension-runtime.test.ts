import { describe, expect, it } from "vitest";
import { registerImagePreviewExtension } from "../src/extension-runtime.ts";
import type { ImageContent } from "../src/content.ts";

type Handler = (...args: any[]) => any;

function createHarness(readImage: (filePath: string) => Promise<ImageContent | null>) {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		sendUserMessage() {},
	};
	const widgetUpdates: unknown[] = [];
	const ctx = {
		cwd: "/tmp",
		isIdle: () => true,
		ui: {
			setWidget(_key: string, content: unknown) {
				widgetUpdates.push(content);
			},
			getEditorText: () => "",
			setEditorText() {},
			theme: {},
		},
	};

	registerImagePreviewExtension(pi, {
		readImageContentFromPathAsync: readImage,
		loadImageContentFromPath: readImage,
	});

	return { handlers, ctx, widgetUpdates };
}

const png: ImageContent = {
	type: "image",
	data: "ZmFrZS1wbmc=",
	mimeType: "image/png",
};

describe("extension input handling", () => {
	it("attaches a just-submitted image path even when polling has not tracked it yet", async () => {
		const reads: string[] = [];
		const { handlers, ctx } = createHarness(async (filePath) => {
			reads.push(filePath);
			return filePath === "/tmp/pi-clipboard-race.png" ? png : null;
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
		const { handlers, ctx } = createHarness(async (filePath) => {
			reads.push(filePath);
			return png;
		});

		const result = await handlers.get("input")!(
			{ text: "/open /tmp/pi-clipboard-race.png" },
			ctx,
		);

		expect(reads).toEqual([]);
		expect(result).toEqual({ action: "continue" });
	});
});
