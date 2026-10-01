// A Pokémon GO style catch screen over the live desk. Each book's code wears a
// breathing target ring; throwing the printed Poké Ball onto a code releases the
// book's cover from it, with its title and author in the top pill and a
// "Gotcha!" bubble beside it. Touching the bubble once shows a QR code for the
// book's Amazon page; touching it again goes there. Lifting the ball off the
// code puts the cover back. referents.js decides when a code has been caught;
// this file only draws and handles the bubble.

const POP_MS = 550;
// How long a fingertip has to rest on the bubble to count as a touch.
const TOUCH_MS = 700;

const covers = new Map();
const amazonQrs = new Map();
// Per caught code: { stage: 0 | 1, rect, touchStart, armed }.
const bubbles = new Map();
let caughtTotal = 0;

function coverImage(data) {
  if (!covers.has(data)) {
    const image = new Image();
    image.src = objectFor(data).cover;
    covers.set(data, image);
  }
  return covers.get(data);
}

// qrcodejs renders into a canvas; the canvas is kept and drawn onto the overlay.
function amazonQr(data) {
  if (!amazonQrs.has(data) && window.QRCode) {
    const holder = document.createElement('div');
    new QRCode(holder, { text: data, width: 256, height: 256, correctLevel: QRCode.CorrectLevel.M });
    amazonQrs.set(data, holder.querySelector('canvas'));
  }
  return amazonQrs.get(data);
}

// Overshoots then settles, like a Pokémon popping out of its ball.
function easeOutBack(t) {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

function setupChrome() {
  const chrome = document.createElement('div');
  chrome.id = 'go-chrome';
  chrome.innerHTML = `
    <div class="go-btn go-run" aria-hidden="true">
      <svg viewBox="0 0 24 24"><circle cx="14" cy="4" r="2"/><path d="M13 7l-4 2-2 4M13 7l2 5 3 2M12 12l-2 5-3 3M12 12l3 3v5"/></svg>
    </div>
    <div class="go-ar" aria-hidden="true"><span>AR</span><i></i></div>
    <div class="go-pill" id="go-pill"><span class="go-pill-dot"></span><span id="go-pill-text">Throw a Poké Ball at a book</span></div>
    <div class="go-ball" aria-hidden="true"><img src="assets/pokeball.png" alt=""><span id="go-count">0</span></div>
    <div class="go-side" aria-hidden="true">
      <div class="go-btn"><svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="3"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2.5h3L15 7"/></svg></div>
      <div class="go-btn"><svg viewBox="0 0 24 24"><path d="M6 9h12l-1 11H7z"/><path d="M9 9V7a3 3 0 0 1 6 0v2"/></svg></div>
    </div>`;
  document.body.appendChild(chrome);
}

function updatePill() {
  const text = document.querySelector('#go-pill-text');
  const latest = [...caught.entries()].sort((a, b) => b[1].caughtAt - a[1].caughtAt)[0];
  text.textContent = latest
    ? `${objectFor(latest[0]).title} / ${objectFor(latest[0]).author}`
    : 'Throw a Poké Ball at a book';
  document.querySelector('#go-count').textContent = caughtTotal;
}

function drawCapture(ctx, now) {
  for (const [data, state] of presence) {
    if (!state.missingSince && !caught.has(data) && state.location) {
      drawTargetRing(ctx, state.location, objectFor(data).color, now);
    }
  }

  for (const [data, entry] of caught) {
    if (!bubbles.has(data)) {
      bubbles.set(data, { stage: 0, rect: null, touchStart: 0, armed: true });
      caughtTotal++;
    }
    drawReleasedCover(ctx, data, entry.location, Math.min(1, (now - entry.caughtAt) / POP_MS), now);
    drawBubble(ctx, data, entry.location, now);
  }
  for (const data of bubbles.keys()) {
    if (!caught.has(data)) {
      bubbles.delete(data);
    }
  }

  for (let i = releasing.length - 1; i >= 0; i--) {
    const entry = releasing[i];
    const t = (now - entry.releasedAt) / RELEASE_MS;
    if (t >= 1) {
      releasing.splice(i, 1);
      continue;
    }
    drawReleasedCover(ctx, entry.data, entry.location, 1 - t, now);
  }

  updatePill();
}

function drawTargetRing(ctx, location, color, now) {
  const center = centerOf(location);
  const breathe = 0.5 + 0.5 * Math.sin(now / 420);
  const radius = sideOf(location) * (0.82 + 0.06 * breathe);

  ctx.save();
  ctx.lineWidth = Math.max(4, sideOf(location) * 0.035);
  ctx.strokeStyle = `rgba(255, 255, 255, ${0.55 + 0.35 * breathe})`;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

// The cover floats a little above its code inside a translucent ring, the way
// a Pokémon stands in its encounter circle. `progress` runs 0..1 on the way out
// and 1..0 on the way back in.
function coverFrame(location, progress, now) {
  const side = sideOf(location);
  const center = centerOf(location);
  const scale = Math.max(0, easeOutBack(progress));
  const height = side * 1.7 * scale;
  const bob = progress >= 1 ? Math.sin(now / 500) * side * 0.04 : 0;
  return {
    x: center.x,
    y: center.y - side * 0.35 * Math.min(1, progress) + bob,
    height,
    ringRadius: side * 1.15 * scale,
  };
}

function drawReleasedCover(ctx, data, location, progress, now) {
  const object = objectFor(data);
  const image = coverImage(data);
  const frame = coverFrame(location, progress, now);
  if (frame.height <= 1) {
    return;
  }

  ctx.save();
  ctx.globalAlpha = Math.min(1, progress * 1.5);
  ctx.fillStyle = hexToRgba(object.color, 0.22);
  ctx.strokeStyle = hexToRgba(object.color, 0.9);
  ctx.lineWidth = Math.max(4, frame.ringRadius * 0.025);
  ctx.beginPath();
  ctx.arc(frame.x, frame.y, frame.ringRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (image.complete && image.naturalWidth) {
    const width = frame.height * (image.naturalWidth / image.naturalHeight);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = frame.height * 0.08;
    ctx.shadowOffsetY = frame.height * 0.04;
    ctx.drawImage(image, frame.x - width / 2, frame.y - frame.height / 2, width, frame.height);
  }
  ctx.restore();
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// The bubble sits to the right of the cover, or the left near the frame edge.
// Its rectangle is kept for hit-testing the fingertip and mouse clicks.
function drawBubble(ctx, data, location, now) {
  const bubble = bubbles.get(data);
  const entry = caught.get(data);
  if (now - entry.caughtAt < POP_MS * 0.8) {
    return;
  }

  const frame = coverFrame(location, 1, now);
  const unit = sideOf(location) * 0.16;
  const qr = bubble.stage === 1 ? amazonQr(data) : null;
  const width = unit * (qr ? 9 : 8);
  const height = qr ? unit * 11.5 : unit * 3.6;
  let x = frame.x + frame.ringRadius * 0.85;
  const flip = x + width > ctx.canvas.width;
  if (flip) {
    x = frame.x - frame.ringRadius * 0.85 - width;
  }
  // Keep clear of the Poké Ball icon along the bottom edge.
  const y = Math.max(unit, Math.min(ctx.canvas.height * 0.82 - height, frame.y - frame.ringRadius * 0.6));
  bubble.rect = { x, y, width, height };

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = unit;
  ctx.fillStyle = '#fbfaf6';
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, unit * 0.9);
  ctx.fill();
  // Tail pointing back at the cover.
  const tailX = flip ? x + width : x;
  const tailDir = flip ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(tailX, y + unit * 1.2);
  ctx.lineTo(tailX + tailDir * unit * 1.1, y + unit * 2.2);
  ctx.lineTo(tailX, y + unit * 2.6);
  ctx.fill();
  ctx.shadowColor = 'transparent';

  ctx.fillStyle = '#2b2a33';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = x + width / 2;
  ctx.font = `800 ${unit * 1.35}px ui-rounded, "SF Pro Rounded", -apple-system, sans-serif`;
  ctx.fillText('Gotcha!', cx, y + unit * 1.5);
  ctx.font = `500 ${unit * 0.6}px ui-rounded, "SF Pro Rounded", -apple-system, sans-serif`;
  ctx.fillStyle = '#6d6b75';
  if (qr) {
    const size = width - unit * 2;
    ctx.drawImage(qr, x + unit, y + unit * 2.8, size, size);
    ctx.fillText('Scan to buy on Amazon', cx, y + unit * 3.4 + size);
    ctx.fillText('touch again to open it here', cx, y + unit * 4.2 + size);
  } else {
    ctx.fillText('touch to buy this book', cx, y + unit * 2.8);
  }

  const progress = bubbleTouchProgress(bubble, now);
  if (progress > 0 && fingertip) {
    ctx.lineWidth = unit * 0.35;
    ctx.lineCap = 'round';
    ctx.strokeStyle = objectFor(data).color;
    ctx.beginPath();
    ctx.arc(fingertip.x, fingertip.y, unit * 1.4, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function insideRect(point, rect) {
  return rect && point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function bubbleTouchProgress(bubble, now) {
  return bubble.touchStart ? Math.min(1, (now - bubble.touchStart) / TOUCH_MS) : 0;
}

// Runs every frame. A touch needs the fingertip to rest on the bubble for
// TOUCH_MS, then leave it before the next touch can start, so one long press
// doesn't skip straight past the QR code to Amazon.
function updateBubbleTouches(now) {
  for (const [data, bubble] of bubbles) {
    const over = fingertip && insideRect(fingertip, bubble.rect);
    if (!over) {
      bubble.touchStart = 0;
      bubble.armed = true;
      continue;
    }
    if (!bubble.armed) {
      continue;
    }
    if (!bubble.touchStart) {
      bubble.touchStart = now;
    }
    if (bubbleTouchProgress(bubble, now) >= 1) {
      bubble.armed = false;
      bubble.touchStart = 0;
      touchBubble(data, bubble);
    }
  }
}

function touchBubble(data, bubble) {
  if (bubble.stage === 0) {
    bubble.stage = 1;
  } else {
    window.location.href = data;
  }
}

// A mouse click works as a touch too: handy for a demo without a hand in
// frame. The video is drawn with object-fit: cover, so the click is mapped
// back into video pixels before hit-testing.
function clickToVideo(event) {
  const scale = Math.max(window.innerWidth / overlay.width, window.innerHeight / overlay.height);
  const offsetX = (window.innerWidth - overlay.width * scale) / 2;
  const offsetY = (window.innerHeight - overlay.height * scale) / 2;
  return { x: (event.clientX - offsetX) / scale, y: (event.clientY - offsetY) / scale };
}

window.addEventListener('click', (event) => {
  if (event.target.closest('#ref-panel')) {
    return;
  }
  const point = clickToVideo(event);
  for (const [data, bubble] of bubbles) {
    if (insideRect(point, bubble.rect)) {
      touchBubble(data, bubble);
      return;
    }
  }
});

setupChrome();
