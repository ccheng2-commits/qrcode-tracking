# Debugging notes: why the tracker couldn't see all six codes

**2026-09-24 · Session 3 · setup: desktop with a top-down camera (Insta360 GO 3S as webcam)**

**Before / after, live:**
[original — jsQR crop windows, green boxes](https://spatial-qrcode-tracking-original.netlify.app)
·
[current — zxing-wasm, emoji markers, tracking](https://spatial-qrcode-tracking.netlify.app)

First day running the app against a real camera and the printed six-code sheet.
On screen: detection came and went, boxes flickered, and at most three of the
six codes were ever recognized at once. This documents the diagnosis, in the
order the layers peeled off, and what each fix changed. Commits are on `main`.

## Symptom 1: a known code showed the fallback green box

The sheet encodes `object-a` (hyphen); the emoji map's keys use spaces
(`object a`). The lookup lowercased and trimmed, but didn't normalize
separators, so a mapped code rendered as an unknown one.

**Fix (`437e016`):** treat hyphens, underscores, and dashes as spaces before
the lookup. Cosmetic, but it proved the camera-to-decode pipeline worked
end to end — which made the remaining misses more interesting.

## Symptom 2: raising the camera made detection *worse*

Intuition said: the scanner assumes ~150px codes, so raise the camera until
the codes shrink to spec. Detection dropped from three codes to two.

The scanner deduplicated detections by *position*: any two detections whose
centers sat within 150px were merged as "the same code seen by two
overlapping windows." Six codes printed close together on one sheet, shrunk
by a higher camera, pushed *different* codes inside the merge radius — and
the dedupe silently ate them. Distance was the wrong identity test.

**Fix (`7dc6872`):** dedupe by decoded text instead. Two detections with the
same text are one code (tracks are keyed by text anyway); different text is
always two codes, regardless of proximity.

## Symptom 3: flicker

The box-persistence grace period was 400ms — tuned for a 30fps scan cadence.
But the tiled scan ran ~72 `getImageData` + jsQR calls per frame, taking a
few hundred milliseconds per pass: the app really scanned 2–5 times per
second. Missing a single pass blew through the grace period, so boxes
vanished and reappeared. The flicker was a timeout mismatch, not the camera.

**Fix (`7dc6872`):** stretch the grace period to cover the real cadence.

## The root cause: jsQR only decodes a code that fills the image

After all of the above, the live camera still found only one code. The
decisive experiment, reproducible in Node against a real webcam photo of the
sheet:

- feed jsQR the **full frame** → nothing, ever
- feed jsQR a **220px crop** centered on any single code → decodes instantly

jsQR effectively requires the code to occupy most of the image it is given.
Seen from there, the crop-window design in this app was never really a
multi-code strategy — it was a workaround for this limitation, and it only
works while its baked-in size assumption (`QR_SIZE = 150`) matches reality.
With a top-down camera at desk height the codes appear at 200px+, so whether
a code was findable depended on whether it happened to land entirely inside
one 300px window. A fixed camera makes that alignment deterministic — which
is why the same one or two codes were recognized, stably, no matter what.

An intermediate attempt (scan the full frame iteratively, masking out each
decoded code) failed for the same reason: jsQR just can't read a busy full
frame. The library was the wall, not the windowing.

## The fix (`cb1b67d`): replace jsQR with zxing-wasm

[zxing-wasm](https://github.com/Sec-ant/zxing-wasm) — the ZXing barcode
engine compiled to WebAssembly, loaded from a CDN via dynamic `import()`,
still vanilla JS, no build step. One `readBarcodes()` call scans the whole
frame and returns *every* code with corner positions, at any code size, in
4–16ms — two orders of magnitude faster than the 72-window pass it replaced.

Deleted along with jsQR: the crop windows, the `QR_SIZE` scan assumption,
and the stretched grace period (back to 500ms; the scan now keeps up with
the frame rate).

Verified before deploying by overriding `getUserMedia` with a synthetic
canvas stream that plays a real photo of the printed sheet: all five codes
visible in that photo were detected and tracked, trails intact. Live camera
confirmed all six.

## What this leaves for class discussion

The interesting question is no longer "how do we scan windows efficiently"
but: **why did the reference implementation choose jsQR + crop windows, what
assumptions did that bake in, and what happens when a physical setup breaks
them?** Every symptom above traced back to an assumption that held on the
author's desk and broke on mine — code size, code spacing, scan cadence.
The camera was never the problem: the remaining failure modes are physical
(glare, wide-angle distortion at the frame edges, a crumpled sheet).
