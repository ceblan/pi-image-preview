import { execFile, execFileSync } from "node:child_process";
import { getCapabilities, type ImageProtocol } from "@earendil-works/pi-tui";

/**
 * Decides whether kitty images can be drawn, working around pi-tui ≥0.67.6,
 * which reports `images: null` inside tmux/screen for safety. Unicode
 * placeholders are made for tmux, so inside tmux we ask tmux which terminals
 * are viewing this pane's session instead of trusting environment variables.
 *
 * Environment variables are not enough: tmux copies KITTY_WINDOW_ID into its
 * global environment, so a pane opened from an SSH client (for example Termux
 * on a phone) still claims to be kitty. Placeholders are pane text, so every
 * client sees them: draw images only when every viewing client speaks kitty.
 */

export type TmuxClient = { termType: string; termName: string };

const KITTY_TERM_TYPE = /^(kitty|ghostty|wezterm|rex)\b/i;
const KITTY_TERM_NAMES = new Set(["xterm-kitty", "xterm-ghostty", "wezterm"]);

export function clientSupportsKitty(client: TmuxClient): boolean {
	return (
		KITTY_TERM_TYPE.test(client.termType) ||
		KITTY_TERM_NAMES.has(client.termName.toLowerCase())
	);
}

const CLIENT_FORMAT =
	"#{session_id}\t#{client_tty}\t#{client_termtype}\t#{client_termname}";

/**
 * Parses the output of one probe: the first line is this pane's session and
 * whether its window is active, the rest are every client on the server.
 * Keeps the clients viewing this pane's session. A header without the window
 * field counts as visible.
 */
export function parseClients(output: string): {
	signature: string;
	clients: TmuxClient[];
	windowActive: boolean;
} {
	const [header = "", ...rest] = output.split("\n").map((line) => line.trim());
	const [session = "", windowActive = "1"] = header.split("\t");
	const rows = rest
		.filter((row) => row && row.split("\t")[0] === session)
		.sort();
	const clients = rows.map((row) => {
		const [, , termType = "", termName = ""] = row.split("\t");
		return { termType, termName };
	});
	return { signature: rows.join("\n"), clients, windowActive: windowActive !== "0" };
}

/**
 * The kitty decision for a set of viewing clients. With no client attached,
 * nothing is shown anyway, so keep the previous decision.
 */
export function decide(
	clients: TmuxClient[],
	previous: boolean,
): boolean {
	if (clients.length === 0) return previous;
	return clients.every(clientSupportsKitty);
}

/**
 * True only when this process runs in a tmux pane. TERM=tmux-* without $TMUX
 * means pi runs downstream of someone else's tmux (ssh out of a pane): that
 * tmux cannot be asked who is watching, and passthrough would not reach it.
 */
export function isInTmuxSession(): boolean {
	return Boolean(process.env.TMUX);
}

function probeArgs(): string[] {
	// One tmux call: this pane's session, then all clients. Resolving the
	// session every time follows a pane moved with join-pane.
	const pane = process.env.TMUX_PANE;
	const target = pane ? ["-t", pane] : [];
	return [
		"display-message",
		"-p",
		...target,
		"#{session_id}\t#{window_active}",
		";",
		"list-clients",
		"-F",
		CLIENT_FORMAT,
	];
}

// ── Probe state ────────────────────────────────────────────

let kitty: boolean | undefined;
let signature = "";
let windowActive: boolean | undefined;
let epoch = 0;
/** When a probe last saw this pane's window visible, and when we last sent image data. */
let lastSeenVisibleAt = 0;
let lastTransmitAt = -1;
const listeners = new Set<() => void>();

function changed(firstProbe: boolean): void {
	// A new epoch tells renderers to send their images again.
	epoch++;
	if (!firstProbe) for (const listener of listeners) listener();
}

/** Records the output of one tmux probe (see probeArgs). Exported for tests. */
export function recordTmuxClients(output: string, now = Date.now()): void {
	const parsed = parseClients(output);
	const firstProbe = kitty === undefined;
	const next = decide(parsed.clients, kitty ?? false);
	const clientsChanged = parsed.signature !== signature || next !== kitty;
	// tmux forwards image data only to clients that can see the pane. If data
	// went out after the last probe that saw the window visible, it may have
	// been dropped while the window was hidden, so send it again on return.
	const missedWhileHidden =
		parsed.windowActive &&
		windowActive === false &&
		lastTransmitAt >= lastSeenVisibleAt;
	signature = parsed.signature;
	kitty = next;
	windowActive = parsed.windowActive;
	if (parsed.windowActive) lastSeenVisibleAt = now;
	if (firstProbe || clientsChanged || missedWhileHidden) changed(firstProbe);
}

/**
 * Without an answer from tmux nobody is confirmed to speak kitty, so images
 * stay off until a probe succeeds. Exported for tests.
 */
export function recordProbeFailure(): void {
	const firstProbe = kitty === undefined;
	signature = "";
	if (kitty === false) return;
	kitty = false;
	changed(firstProbe);
}

/** Called whenever kitty image data is written to the terminal. */
export function noteImageTransmitted(now = Date.now()): void {
	lastTransmitAt = now;
}

function probeSync(): void {
	try {
		recordTmuxClients(
			execFileSync("tmux", probeArgs(), {
				encoding: "utf8",
				timeout: 250,
				stdio: ["ignore", "pipe", "ignore"],
			}),
		);
	} catch {
		recordProbeFailure();
	}
}

let timer: ReturnType<typeof setInterval> | undefined;
let probing = false;

/**
 * Poll tmux once a second without blocking, and call `onChange` when the
 * viewing clients change. Returns a function that stops this listener.
 */
export function watchTmuxClients(onChange: () => void): () => void {
	listeners.add(onChange);
	if (!timer && isInTmuxSession()) {
		timer = setInterval(() => {
			if (probing) return;
			probing = true;
			execFile(
				"tmux",
				probeArgs(),
				{ encoding: "utf8", timeout: 1000 },
				(error, stdout) => {
					probing = false;
					if (error) recordProbeFailure();
					else recordTmuxClients(stdout);
				},
			);
		}, 1000);
		timer.unref?.();
	}
	return () => {
		listeners.delete(onChange);
		if (listeners.size === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};
}

/** Changes whenever images must be sent to the terminal again. */
export function imageEpoch(): number {
	return epoch;
}

export function detectImageProtocol(): ImageProtocol | null {
	if (!isInTmuxSession()) return getCapabilities().images;
	// Inside tmux only the probe counts: pi's own answer is always null here,
	// and inline-images may have overridden it to "kitty".
	if (kitty === undefined) probeSync();
	return kitty ? "kitty" : null;
}
