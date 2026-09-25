# Runtime Behavior

Runtime behavior describes how pi-image-preview tracks editor image paths, renders previews, and attaches images during prompt submission.

## Draft Tracking

Draft tracking keeps the preview widget aligned with image paths currently visible in the editor.

The extension polls editor text every 250ms, extracts image paths, loads full-resolution image content for future message attachment, and builds small preview thumbnails for rendering. Removed paths are dropped from the tracked draft state.

## Submit-time Sync

Submit-time sync closes the race between Ctrl+V paste insertion and the polling loop without delaying user-message transcription.

When the input event fires, the extension first rejects slash commands and shell escapes. It then checks whether every image path in the submitted text is already tracked. If so — the common case, since the 250ms poller has usually loaded the image already — it returns the transform synchronously using the cached entries, so pi-core emits `message_start` for the user message as fast as a normal text prompt. Only when the submitted text references a path the poller has not tracked yet (a Ctrl+V followed by Enter within 250ms) does it pay for an async `syncTrackedImagesFromText` against the submitted text before collecting attachments. This keeps the race fix (image still attaches) while keeping the common case non-blocking, since the await would otherwise gate pi-core's user-message transcription.

## Message Attachment

Message attachment sends the full image to pi while leaving user-visible text intact.

After submit-time sync, every tracked path still present in the submitted text contributes its full-resolution image to the input transform result. The original text is preserved so the chat remains understandable and the draft preview state is cleared. Immediate "prompt sent" feedback for image-bearing prompts is not this extension's job: it belongs to whichever extension blocks `before_agent_start` with slow work (e.g. image-vision's auto-analysis, which emits its own status line), because that is where the transcription delay actually comes from.
