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

// Engine-comparison build: identical to the reference implementation except
// for the scanner — zxing-wasm reads every code in the frame in a single
// call, at any code size, so the crop windows and the code-size constant
// they were tuned to are gone. Detections are still drawn raw, one frame at
// a time, with no smoothing or persistence: what you see is exactly what the
// engine returns each frame.
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
    const qrCodes = await scanForQRCodes();

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    for (const qrCode of qrCodes) {
      drawBox(qrCode.location);
      drawLabel(qrCode.location, qrCode.data);
    }
  }

  requestAnimationFrame(tick);
}

async function scanForQRCodes() {
  const readBarcodes = await zxingReady;
  const frame = sampleCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
  const results = await readBarcodes(frame);

  return results
    .filter((result) => result.text)
    .map((result) => ({
      data: result.text,
      location: {
        topLeftCorner: result.position.topLeft,
        topRightCorner: result.position.topRight,
        bottomRightCorner: result.position.bottomRight,
        bottomLeftCorner: result.position.bottomLeft,
      },
    }));
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
