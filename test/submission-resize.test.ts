import { describe, expect, it, vi } from "vitest";
import {
	resizeForSubmission,
	SUBMISSION_MAX_BYTES,
	SUBMISSION_MAX_DIMENSION,
} from "../src/submission-resize.ts";

// Build a base64 payload string of exactly `encodedLength` characters. The
// submission gate measures this encoded length — the axis the provider's
// per-image limit applies to — not the decoded byte count.
const base64Payload = (encodedLength: number): string =>
	"A".repeat(encodedLength);

describe("submission image resizing", () => {
	it("returns the image unchanged when its base64 payload is within the cap", async () => {
		const resizeImage = vi.fn();
		const original = {
			type: "image" as const,
			data: base64Payload(SUBMISSION_MAX_BYTES),
			mimeType: "image/png",
		};

		const result = await resizeForSubmission(original, { resizeImage });

		expect(result).toBe(original);
		expect(resizeImage).not.toHaveBeenCalled();
	});

	it("downscales an image whose base64 payload exceeds the cap and preserves its format", async () => {
		const resizeImage = vi.fn(async () => ({
			data: base64Payload(1024),
			mimeType: "image/png",
		}));
		const original = {
			type: "image" as const,
			data: base64Payload(SUBMISSION_MAX_BYTES + 4),
			mimeType: "image/png",
		};

		const result = await resizeForSubmission(original, { resizeImage });

		expect(result).toEqual({
			type: "image",
			data: base64Payload(1024),
			mimeType: "image/png",
		});

		const [bytes, mimeType, options] = resizeImage.mock.calls[0];
		expect(bytes.length).toBe(Buffer.from(original.data, "base64").length);
		expect(mimeType).toBe("image/png");
		expect(options).toEqual({
			maxWidth: SUBMISSION_MAX_DIMENSION,
			maxHeight: SUBMISSION_MAX_DIMENSION,
			maxBytes: SUBMISSION_MAX_BYTES,
		});
	});

	it("warns and keeps the original when the resizer cannot shrink it", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const resizeImage = vi.fn(async () => null);
		const original = {
			type: "image" as const,
			data: base64Payload(SUBMISSION_MAX_BYTES + 4),
			mimeType: "image/png",
		};

		const result = await resizeForSubmission(original, { resizeImage });

		expect(result).toBe(original);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("warns and keeps the original when the resizer throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const resizeImage = vi.fn(async () => {
			throw new Error("resize unavailable");
		});
		const original = {
			type: "image" as const,
			data: base64Payload(SUBMISSION_MAX_BYTES + 4),
			mimeType: "image/png",
		};

		const result = await resizeForSubmission(original, { resizeImage });

		expect(result).toBe(original);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
