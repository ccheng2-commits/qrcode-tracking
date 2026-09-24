const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

let sampleCanvas;
let sampleCtx;

const VIDEO_CONSTRAINTS = {
  video: {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

// Fallback size for drawing when a detection is degenerate; the scan itself
// makes no assumption about code size.
const QR_SIZE = 150;
// zxing-wasm reads every code in the frame in a single call, at any size,
// in a few milliseconds. It replaced the earlier jsQR pipeline: jsQR can
// only decode a code that mostly fills the image it is given, so it needed
// fixed-size crop windows tuned to one viewing distance, and codes larger
// than the window overlap were silently unfindable.
const zxingReady = import('https://cdn.jsdelivr.net/npm/zxing-wasm@3.1.4/dist/es/reader/index.js')
  .then((zxing) => (imageData) => zxing.readBarcodes(imageData, {
    formats: ['QRCode'],
    maxNumberOfSymbols: 8,
    tryHarder: true,
  }))
  .catch((error) => {
    console.error('Unable to load the barcode reader:', error);
    return () => [];
  });

// How long a code keeps its box after the last frame it was decoded in. The
// scan drops a code every few frames — motion blur, or a glare on the
// paper — and without this grace period the boxes flicker.
const TRACK_TIMEOUT_MS = 500;
// Past centers kept per code. At ~30fps this is roughly a second of movement,
// enough to read which way a code is travelling.
const TRAIL_LENGTH = 30;

// Codes seen recently, keyed by their decoded text. That text is the only
// identity a QR code carries, so two codes printed with the same content are
// a single track as far as this app is concerned.
const tracks = new Map();

// Decoded text mapped to the marker drawn over the code, so a printed code
// stands in for the object it names. Lookup is case-insensitive and treats
// hyphens, underscores, and dashes as spaces, so the printed "object-a"
// matches "object a"; codes whose text isn't listed keep the plain box and
// text label.
const EMOJI_MARKERS = {
  'phone': '📱',
  'object a': '🌸',
  'object b': '🌻',
  'object c': '🌺',
  'bottle': '🍾',
  'notebook': '📓',
  'book': '📕',
  'cup': '☕',
  'mug': '☕',
  'laptop': '💻',
  'keyboard': '⌨️',
  'mouse': '🖱️',
  'pen': '🖊️',
  'pencil': '✏️',
  'plant': '🪴',
  'scissors': '✂️',
  'headphones': '🎧',
  'glasses': '👓',
  'key': '🔑',
  'keys': '🔑',
  'wallet': '👛',
  'watch': '⌚',
};

function markerFor(data) {
  const key = data.toLowerCase().replace(/[-_–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  return EMOJI_MARKERS[key];
}

navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS)
  .then((stream) => {
    video.srcObject = stream;
  })
  .catch((error) => {
    console.error('Unable to access webcam:', error);
  });

video.addEventListener('loadedmetadata', () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;

  sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = video.videoWidth;
  sampleCanvas.height = video.videoHeight;
  sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  requestAnimationFrame(tick);
});

// The scan is asynchronous, so the next frame is only scheduled once the
// current one is fully processed — scans never overlap or pile up.
async function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);

    updateTracks(await scanForQRCodes(), performance.now());

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    for (const track of tracks.values()) {
      drawTrail(track);
      const emoji = markerFor(track.data);
      if (emoji) {
        drawEmoji(track.location, emoji);
      } else {
        drawBox(track.location);
        drawLabel(track.location, track.data);
      }
    }
  }

  requestAnimationFrame(tick);
}

// Fold this frame's detections into the tracks, then drop the tracks that
// haven't been seen for a while. Everything the overlay draws comes from here,
// so a code that goes missing for a frame or two keeps its box and its trail.
function updateTracks(qrCodes, now) {
  for (const qrCode of qrCodes) {
    const track = tracks.get(qrCode.data);

    if (track) {
      track.location = qrCode.location;
      track.lastSeen = now;
      track.trail.push(centerOf(qrCode.location));
      if (track.trail.length > TRAIL_LENGTH) {
        track.trail.shift();
      }
    } else {
      tracks.set(qrCode.data, {
        data: qrCode.data,
        location: qrCode.location,
        lastSeen: now,
        trail: [centerOf(qrCode.location)],
      });
    }
  }

  for (const [data, track] of tracks) {
    if (now - track.lastSeen > TRACK_TIMEOUT_MS) {
      tracks.delete(data);
    }
  }
}

async function scanForQRCodes() {
  const readBarcodes = await zxingReady;
  const frame = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
  const results = await readBarcodes(frame);

  return dedupeDetections(results
    .filter((result) => result.text)
    .map((result) => ({
      data: result.text,
      location: {
        topLeftCorner: result.position.topLeft,
        topRightCorner: result.position.topRight,
        bottomRightCorner: result.position.bottomRight,
        bottomLeftCorner: result.position.bottomLeft,
      },
    })));
}

// The same QR code is often found in more than one overlapping tile. Two
// detections that decode to the same text are the same code as far as this
// app is concerned (tracks are keyed by text), so keep the first of each;
// detections with different text are always distinct codes, no matter how
// close together they sit in the frame.
function dedupeDetections(detections) {
  const seen = new Set();
  const unique = [];

  for (const detection of detections) {
    if (!seen.has(detection.data)) {
      seen.add(detection.data);
      unique.push(detection);
    }
  }

  return unique;
}

function centerOf(location) {
  const { topLeftCorner, bottomRightCorner } = location;
  return {
    x: (topLeftCorner.x + bottomRightCorner.x) / 2,
    y: (topLeftCorner.y + bottomRightCorner.y) / 2,
  };
}

// The trail fades towards its oldest point, so the bright end reads as where
// the code is now without needing an arrowhead.
function drawTrail(track) {
  if (track.trail.length < 2) {
    return;
  }

  overlayCtx.lineWidth = Math.max(2, overlay.width * 0.003);
  overlayCtx.lineCap = 'round';

  for (let i = 1; i < track.trail.length; i++) {
    const from = track.trail[i - 1];
    const to = track.trail[i];

    overlayCtx.strokeStyle = `rgba(0, 255, 0, ${(i / track.trail.length) * 0.6})`;
    overlayCtx.beginPath();
    overlayCtx.moveTo(from.x, from.y);
    overlayCtx.lineTo(to.x, to.y);
    overlayCtx.stroke();
  }
}

// The emoji is sized from the detected top edge rather than QR_SIZE so it
// covers the printed code even when the code sits nearer or farther than the
// size the scanner assumes. textAlign is restored because drawLabel relies on
// the canvas default.
function drawEmoji(location, emoji) {
  const { topLeftCorner, topRightCorner } = location;
  const dx = topRightCorner.x - topLeftCorner.x;
  const dy = topRightCorner.y - topLeftCorner.y;
  const size = Math.max(QR_SIZE * 0.8, Math.sqrt(dx * dx + dy * dy)) * 1.2;
  const center = centerOf(location);

  overlayCtx.font = `${size}px sans-serif`;
  overlayCtx.textAlign = 'center';
  overlayCtx.textBaseline = 'middle';
  overlayCtx.fillText(emoji, center.x, center.y);
  overlayCtx.textAlign = 'start';
}

function drawBox(location) {
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = location;

  overlayCtx.strokeStyle = '#00ff00';
  overlayCtx.lineWidth = Math.max(4, overlay.width * 0.006);
  overlayCtx.beginPath();
  overlayCtx.moveTo(topLeftCorner.x, topLeftCorner.y);
  overlayCtx.lineTo(topRightCorner.x, topRightCorner.y);
  overlayCtx.lineTo(bottomRightCorner.x, bottomRightCorner.y);
  overlayCtx.lineTo(bottomLeftCorner.x, bottomLeftCorner.y);
  overlayCtx.closePath();
  overlayCtx.stroke();
}

function drawLabel(location, text) {
  const { bottomLeftCorner, bottomRightCorner } = location;

  const fontSize = Math.max(16, overlay.width * 0.02);
  const padding = fontSize * 0.25;
  const x = Math.min(bottomLeftCorner.x, bottomRightCorner.x);
  const y = Math.max(bottomLeftCorner.y, bottomRightCorner.y) + padding;

  overlayCtx.font = `${fontSize}px monospace`;
  overlayCtx.textBaseline = 'top';
  const textWidth = overlayCtx.measureText(text).width;

  overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  overlayCtx.fillRect(x - padding, y - padding, textWidth + padding * 2, fontSize + padding * 2);

  overlayCtx.fillStyle = '#00ff00';
  overlayCtx.fillText(text, x, y);
}
