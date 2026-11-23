import type { ImageContent } from "./content.ts";

/** Providers reject images larger than ~5 MB per image, measured on the base64
 * payload sent over the wire. Cap the full-size attachment (distinct from the
 * tiny gallery thumbnail) a little below that hard wall for headroom. */
export const SUBMISSION_MAX_BYTES = 4.5 * 1024 * 1024;
/** Keep the attachment high-resolution — only bound it below the API pixel
 * limit so quality is preserved while the byte cap does the real shrinking. */
export const SUBMISSION_MAX_DIMENSION = 8000;

type ResizedImage = { data: string; mimeType: string };

export interface SubmissionResizeDeps {
	/** Resize raw image bytes within the given bounds (pi's WASM resizer). */
	resizeImage: (
		bytes: Uint8Array,
		mimeType: string,
		options: { maxWidth: number; maxHeight: number; maxBytes: number },
	) => Promise<ResizedImage | null>;
}

/**
 * Downscale the full-resolution image so the submitted attachment stays under
 * the provider's per-image byte limit. The original format is preserved (no
 * PNG conversion); images already within the cap are returned unchanged.
 */
export async function resizeForSubmission(
	image: ImageContent,
	deps: SubmissionResizeDeps,
): Promise<ImageContent> {
	try {
		// Gate on the encoded payload — the axis the provider's limit applies to.
		// base64 is ASCII, so the string length equals its byte size.
		if (image.data.length <= SUBMISSION_MAX_BYTES) return image;
		const bytes = Buffer.from(image.data, "base64");
		const resized = await deps.resizeImage(bytes, image.mimeType, {
			maxWidth: SUBMISSION_MAX_DIMENSION,
			maxHeight: SUBMISSION_MAX_DIMENSION,
			maxBytes: SUBMISSION_MAX_BYTES,
		});
		if (!resized) {
			console.warn(
				`[image-preview] could not downscale a ${(image.data.length / 1024 / 1024).toFixed(1)}MB attachment below the ${(SUBMISSION_MAX_BYTES / 1024 / 1024).toFixed(1)}MB limit; submitting it unchanged`,
			);
			return image;
		}
		return { type: "image", data: resized.data, mimeType: resized.mimeType };
	} catch (err) {
		console.warn(
			"[image-preview] failed to downscale an oversized attachment; submitting it unchanged",
			err,
		);
		return image;
	}
}
