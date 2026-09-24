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

// Approximate size of a QR code in the captured frame, in pixels.
const QR_SIZE = 150;
// jsQR only ever returns one decoded symbol per call, so to find multiple
// codes in a frame we scan overlapping crop windows across the image and
// decode each one separately. The window is bigger than a code (with room
// for its quiet zone) and the step is small enough that the overlap between
// adjacent windows is at least one code-width, so no code can fall entirely
// across a window boundary and get missed.
const TILE_SIZE = QR_SIZE * 2;
const TILE_STEP = QR_SIZE;

// How long a code keeps its box after the last frame it was decoded in. The
// tiled scan drops a code every few frames — motion blur, or a glare on the
// paper — and without this grace period the boxes flicker.
const TRACK_TIMEOUT_MS = 400;
// Past centers kept per code. At ~30fps this is roughly a second of movement,
// enough to read which way a code is travelling.
const TRAIL_LENGTH = 30;

// Codes seen recently, keyed by their decoded text. That text is the only
// identity a QR code carries, so two codes printed with the same content are
// a single track as far as this app is concerned.
const tracks = new Map();

// Decoded text mapped to the marker drawn over the code, so a printed code
// stands in for the object it names. Lookup is case-insensitive; codes whose
// text isn't listed keep the plain box and text label.
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
  return EMOJI_MARKERS[data.trim().toLowerCase()];
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

function tick() {
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    sampleCtx.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);

    updateTracks(scanForQRCodes(), performance.now());

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

function scanForQRCodes() {
  const xs = getTilePositions(sampleCanvas.width);
  const ys = getTilePositions(sampleCanvas.height);
  const detections = [];

  for (const y of ys) {
    for (const x of xs) {
      const tile = sampleCtx.getImageData(x, y, TILE_SIZE, TILE_SIZE);
      const qrCode = jsQR(tile.data, TILE_SIZE, TILE_SIZE);
      if (qrCode) {
        detections.push(offsetQRCode(qrCode, x, y));
      }
    }
  }

  return dedupeDetections(detections);
}

// Start offsets for tiles of TILE_SIZE covering `dimension`, stepping by
// TILE_STEP and with a final tile flush against the far edge so the whole
// frame is covered even when it doesn't divide evenly by the step.
function getTilePositions(dimension) {
  if (dimension <= TILE_SIZE) {
    return [0];
  }

  const positions = [];
  for (let pos = 0; pos + TILE_SIZE <= dimension; pos += TILE_STEP) {
    positions.push(pos);
  }

  const lastPosition = dimension - TILE_SIZE;
  if (positions[positions.length - 1] !== lastPosition) {
    positions.push(lastPosition);
  }

  return positions;
}

function offsetQRCode(qrCode, offsetX, offsetY) {
  const shift = (point) => ({ x: point.x + offsetX, y: point.y + offsetY });
  const { topLeftCorner, topRightCorner, bottomRightCorner, bottomLeftCorner } = qrCode.location;

  return {
    data: qrCode.data,
    location: {
      topLeftCorner: shift(topLeftCorner),
      topRightCorner: shift(topRightCorner),
      bottomRightCorner: shift(bottomRightCorner),
      bottomLeftCorner: shift(bottomLeftCorner),
    },
  };
}

// The same QR code is often found in more than one overlapping tile, so
// collapse detections whose bounding boxes are centered near each other.
function dedupeDetections(detections) {
  const unique = [];

  for (const detection of detections) {
    const center = centerOf(detection.location);
    const isDuplicate = unique.some((existing) => {
      const existingCenter = centerOf(existing.location);
      const dx = center.x - existingCenter.x;
      const dy = center.y - existingCenter.y;
      return Math.sqrt(dx * dx + dy * dy) < QR_SIZE;
    });

    if (!isDuplicate) {
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
