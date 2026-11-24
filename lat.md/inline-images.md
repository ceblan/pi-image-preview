# Inline Chat Images

Inline chat images let the images pi itself draws in the transcript — tool results such as `read` on an image file — render inside tmux, where pi-tui reports no image support.

pi-tui ≥0.67.6 answers `images: null` inside tmux and screen, because direct kitty placements are not tied to a pane, and pi then skips creating image components altogether. [[src/inline-images.ts#installInlineImages]] is installed on `session_start` and undoes that only where it is safe: outside tmux, or when pi-tui already draws images, it is a no-op.

## Scope

Scope limits inline chat images to what pi draws itself; attachments submitted by this extension are not among them.

pi renders a user message from its text blocks only, so an image attached through [[runtime#Message Attachment]] is sent to the model but never drawn by pi in the transcript. The extension keeps its own thumbnail beside the message instead (see [[runtime#Transcript Thumbnail]]); only tool-result images reach the patch below.

## Capability Override

The capability override tells pi that images work so it builds its usual image components, and is undone whenever a viewer that does not speak kitty is attached.

[[src/inline-images.ts#syncCapabilities]] saves pi-tui's capabilities, then sets `images: "kitty"` while [[src/image-protocol.ts#detectImageProtocol]] answers "kitty". pi resets its capability cache when terminal settings change, which drops the override, so it is re-applied on every viewer change whenever it is missing.

## Placeholder Rendering

Placeholder rendering swaps pi's direct kitty placement for Unicode placeholders, which tmux stores as pane text and therefore manages per pane.

`Image.prototype.render` is patched: the original render runs once to learn the cell size (`c=`/`r=`) pi-tui chose, then [[src/inline-images.ts#sendOnce]] transmits the PNG with `U=1` through tmux passthrough and the patch returns rows of U+10EEEE placeholders. Sent data is cached by base64 payload, because pi rebuilds image components on every invalidate.

## Viewer Probing

Viewer probing asks tmux which terminals are attached instead of trusting environment variables, which describe the terminal that started the server.

Every second [[src/image-protocol.ts#watchTmuxClients]] runs one `tmux` call listing the clients of this pane's session; images stay on only while every viewer satisfies [[src/image-protocol.ts#clientSupportsKitty]]. A probe failure turns images off until a probe succeeds, since passthrough would otherwise reach an unknown client.

## Resend Epochs

Resend epochs make renderers send image data again whenever a viewer may have missed it.

[[src/image-protocol.ts#recordTmuxClients]] raises the epoch when the viewers change, or when the pane's window becomes visible again after data went out while it was hidden; tmux forwards passthrough only to clients that can see the pane. Placeholder lines are cached per width and epoch, so a new epoch re-renders and re-transmits under the same image id.

## TUI Capture

TUI capture finds pi's renderer so a viewer change can invalidate the whole component tree and request a frame.

Whichever frame runs first hands over the instance: the regular TUI through `Container.prototype.render`, the fullscreen TUI through its per-frame `doRender()`. The fullscreen TUI renders through a layout root and never runs `Container.render` with itself as `this`, so hooking `Container` alone left `tuiMode: fullscreen` without redraws. See [[src/inline-images.ts#captureTui]].
