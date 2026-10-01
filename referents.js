// Object referents: a small library of known objects (books), each referred to
// by the QR code taped to it. The page can attach notes and photos to an
// object, show an object's notes while it is on the desk, search notes to find
// which object holds them, and remember where on the desk each object was last
// seen. Notes live in localStorage, so they survive a reload on the same
// browser.
//
// Covering a code with a finger is a button press. A hand model finds the
// index fingertip; a code that has been steady on the desk and then vanishes
// with the fingertip over it was pressed, not taken away. Holding the press for
// PRESS_MS selects that object. If the hand model can't load, a code that
// vanishes while other codes stay visible counts as covered instead.

// The printed codes carry each book's Amazon URL, so a phone camera opens the
// book's page and this app recognises the same text as the book.
const OBJECTS = {
  'https://www.amazon.com/dp/0143109790': {
    title: 'Reclaiming Conversation',
    author: 'Sherry Turkle',
    color: '#d6453d',
  },
  'https://www.amazon.com/dp/1616896566': {
    title: 'Coffee Lids',
    author: 'Louise Harpman & Scott Specht',
    color: '#b07a4f',
  },
  'https://www.amazon.com/dp/0262542048': {
    title: 'Code as Creative Medium',
    author: 'Golan Levin & Tega Brain',
    color: '#5b7fd6',
  },
};

const STORAGE_KEY = 'object-referents-v1';
// A code must be on the desk this long before covering it counts as a press,
// so a code that flickers in and out at the edge of the frame never fires.
const STEADY_MS = 1000;
// How long the cover has to be held.
const PRESS_MS = 700;
// Missing longer than this means the object left the desk.
const REMOVED_MS = 3000;

const store = loadStore();
// Per-object presence on the desk, keyed by code text.
const presence = new Map();
const imageCache = new Map();

// Index fingertip in video pixels, or null when no hand is in view.
let fingertip = null;
let handLandmarker = null;
let lastHandAt = -1;

const MEDIAPIPE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
import(`${MEDIAPIPE}/vision_bundle.mjs`)
  .then(async ({ FilesetResolver, HandLandmarker }) => {
    const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  })
  .catch((error) => {
    console.error('Hand model unavailable, falling back to occlusion only:', error);
  });

// Landmark 8 is the index fingertip. With two hands in view, the one nearer a
// known object wins, since that is the one doing the pressing.
function updateFingertip(now) {
  if (!handLandmarker || now <= lastHandAt) {
    return;
  }
  lastHandAt = now;
  const result = handLandmarker.detectForVideo(video, now);
  const tips = result.landmarks.map((hand) => ({
    x: hand[8].x * video.videoWidth,
    y: hand[8].y * video.videoHeight,
  }));
  fingertip = tips.length ? tips.reduce((best, tip) => (distanceToNearestObject(tip) < distanceToNearestObject(best) ? tip : best)) : null;
}

function distanceToNearestObject(point) {
  let nearest = Infinity;
  for (const state of presence.values()) {
    if (state.location) {
      const center = centerOf(state.location);
      nearest = Math.min(nearest, Math.hypot(point.x - center.x, point.y - center.y));
    }
  }
  return nearest;
}

function fingertipOver(location) {
  if (!fingertip) {
    return false;
  }
  const center = centerOf(location);
  return Math.hypot(fingertip.x - center.x, fingertip.y - center.y) < sideOf(location) * 0.9;
}

function drawFingertip(ctx) {
  if (!fingertip) {
    return;
  }
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(fingertip.x, fingertip.y, Math.max(10, ctx.canvas.width * 0.008), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

let query = '';
let selected = null;
let selectedAt = 0;

function objectFor(data) {
  return OBJECTS[data];
}

function loadStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { notes: {}, lastSeen: {} };
  } catch {
    return { notes: {}, lastSeen: {} };
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.error('Unable to save notes:', error);
  }
}

function notesFor(data) {
  return store.notes[data] || [];
}

function addNote(data, text, image) {
  if (!text && !image) {
    return;
  }
  (store.notes[data] ||= []).push({ text, image, at: Date.now() });
  saveStore();
  renderPanel();
}

function matchesQuery(data) {
  if (!query) {
    return false;
  }
  const object = objectFor(data);
  const haystack = [object.title, object.author, ...notesFor(data).map((note) => note.text || '')]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

// Called once per frame with the codes decoded in that frame (not the
// smoothed tracks), so a covered code is noticed as soon as it disappears.
function updatePresence(detections, now, frameWidth, frameHeight) {
  const visible = new Set();

  for (const detection of detections) {
    if (!objectFor(detection.data)) {
      continue;
    }
    visible.add(detection.data);

    let state = presence.get(detection.data);
    if (!state || state.missingSince) {
      const steadySince = state && now - state.missingSince < PRESS_MS ? state.steadySince : now;
      state = { steadySince, missingSince: 0, fired: false };
      presence.set(detection.data, state);
    }
    state.location = detection.location;

    const center = centerOf(detection.location);
    store.lastSeen[detection.data] = {
      x: center.x / frameWidth,
      y: center.y / frameHeight,
      at: Date.now(),
    };
  }

  const othersVisible = detections.length > 0;

  for (const [data, state] of presence) {
    if (visible.has(data)) {
      continue;
    }
    if (!state.missingSince) {
      state.missingSince = now;
    }

    const missingFor = now - state.missingSince;
    const wasSteady = state.missingSince - state.steadySince >= STEADY_MS;

    // With the hand model, the fingertip has to be over the code; without it,
    // other codes staying visible rules out the whole camera being blocked.
    const pressing = handLandmarker ? fingertipOver(state.location) : othersVisible;
    if (!state.fired && wasSteady && pressing && missingFor >= PRESS_MS) {
      state.fired = true;
      select(data);
    }
    if (missingFor > REMOVED_MS) {
      presence.delete(data);
      saveStore();
      renderPanel();
    }
  }
}

function select(data) {
  selected = data;
  selectedAt = performance.now();
  renderPanel();
  const input = document.querySelector('#ref-note');
  if (input) {
    input.focus();
  }
}

// Progress of a cover in progress, 0..1, or null when the code isn't covered.
function coverProgress(state, now) {
  if (!state.missingSince || state.fired) {
    return null;
  }
  if (state.missingSince - state.steadySince < STEADY_MS) {
    return null;
  }
  if (handLandmarker && !fingertipOver(state.location)) {
    return null;
  }
  return Math.min(1, (now - state.missingSince) / PRESS_MS);
}

function drawReferents(ctx, tracks, now) {
  const highlighting = query && [...Object.keys(OBJECTS)].some(matchesQuery);

  for (const track of tracks.values()) {
    const object = objectFor(track.data);
    if (!object) {
      continue;
    }
    const hit = matchesQuery(track.data);
    const dim = highlighting && !hit;
    drawObjectOutline(ctx, track.location, object.color, hit, dim, now);
    if (!dim) {
      drawCard(ctx, track.location, track.data, object, track.data === selected);
    }
  }

  for (const [data, state] of presence) {
    const progress = coverProgress(state, now);
    if (progress !== null && state.location) {
      drawCoverRing(ctx, state.location, objectFor(data).color, progress);
    }
  }
}

function quadOf(location) {
  const { topLeftCorner: a, topRightCorner: b, bottomRightCorner: c, bottomLeftCorner: d } = location;
  return [a, b, c, d];
}

function sideOf(location) {
  const [a, b] = quadOf(location);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function drawObjectOutline(ctx, location, color, hit, dim, now) {
  const pad = sideOf(location) * 0.12;
  const center = centerOf(location);
  const points = quadOf(location).map((p) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / length) * pad, y: p.y + (dy / length) * pad };
  });

  ctx.save();
  ctx.globalAlpha = dim ? 0.25 : 1;
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';
  ctx.lineWidth = hit ? 10 + 4 * Math.sin(now / 150) : 6;
  if (hit) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 40;
  }
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

function drawCoverRing(ctx, location, color, progress) {
  const center = centerOf(location);
  const radius = sideOf(location) * 0.45;

  ctx.save();
  ctx.lineWidth = Math.max(8, radius * 0.18);
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function imageFor(src) {
  if (!imageCache.has(src)) {
    const image = new Image();
    image.src = src;
    imageCache.set(src, image);
  }
  return imageCache.get(src);
}

// The card sits to the right of the code, and flips to the left when it would
// run off the frame. A selected object shows all its notes and its newest
// photo; otherwise only the newest note.
function drawCard(ctx, location, data, object, isSelected) {
  const side = sideOf(location);
  const fontSize = Math.max(18, ctx.canvas.width * 0.014);
  const width = fontSize * (isSelected ? 18 : 14);
  const padding = fontSize * 0.7;
  const notes = notesFor(data);
  const shown = isSelected ? notes.slice(-4) : notes.slice(-1);
  const photo = isSelected ? [...notes].reverse().find((note) => note.image) : null;

  ctx.save();
  ctx.font = `${fontSize}px sans-serif`;
  const lines = [];
  for (const note of shown) {
    if (note.text) {
      lines.push(...wrap(ctx, `“${note.text}”`, width - padding * 2));
    }
  }
  if (!notes.length) {
    lines.push('No notes yet — cover the code to add one.');
  }

  const photoImage = photo && imageFor(photo.image);
  const photoHeight = photoImage && photoImage.complete && photoImage.naturalWidth
    ? (width - padding * 2) * (photoImage.naturalHeight / photoImage.naturalWidth)
    : 0;
  const height = padding * 2 + fontSize * 2.6 + lines.length * fontSize * 1.3
    + (photoHeight ? photoHeight + padding : 0);

  const center = centerOf(location);
  let x = center.x + side * 0.75;
  if (x + width > ctx.canvas.width) {
    x = center.x - side * 0.75 - width;
  }
  const y = Math.max(0, Math.min(ctx.canvas.height - height, center.y - height / 2));

  ctx.fillStyle = 'rgba(20, 18, 16, 0.82)';
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, fontSize * 0.5);
  ctx.fill();
  ctx.fillStyle = object.color;
  ctx.fillRect(x, y + fontSize * 0.5, fontSize * 0.25, height - fontSize);

  ctx.textBaseline = 'top';
  let cursor = y + padding;
  ctx.fillStyle = '#f6efe4';
  ctx.font = `600 ${fontSize * 1.1}px sans-serif`;
  ctx.fillText(object.title, x + padding, cursor);
  cursor += fontSize * 1.4;
  ctx.fillStyle = 'rgba(246, 239, 228, 0.6)';
  ctx.font = `${fontSize * 0.8}px sans-serif`;
  ctx.fillText(object.author, x + padding, cursor);
  cursor += fontSize * 1.2;

  ctx.fillStyle = '#f6efe4';
  ctx.font = `${fontSize}px sans-serif`;
  for (const line of lines) {
    ctx.fillText(line, x + padding, cursor);
    cursor += fontSize * 1.3;
  }
  if (photoHeight) {
    ctx.drawImage(photoImage, x + padding, cursor + padding * 0.5, width - padding * 2, photoHeight);
  }
  ctx.restore();
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines;
}

// Where on the desk a point sits, in words: the location referent.
function describeSpot(spot) {
  const column = spot.x < 1 / 3 ? 'left' : spot.x > 2 / 3 ? 'right' : 'center';
  const row = spot.y < 1 / 3 ? 'top' : spot.y > 2 / 3 ? 'bottom' : 'middle';
  if (row === 'middle' && column === 'center') {
    return 'the middle of the desk';
  }
  return `the ${row === 'middle' ? '' : `${row} `}${column === 'center' ? 'center' : column}`.trim()
    + ' of the desk';
}

function ago(at) {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function statusFor(data) {
  if (presence.has(data)) {
    return 'on the desk now';
  }
  const spot = store.lastSeen[data];
  return spot ? `last seen at ${describeSpot(spot)}, ${ago(spot.at)}` : 'not seen yet';
}

// Photos are shrunk before they go into localStorage, which holds only a few
// megabytes per site.
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const image = new Image();
      image.onerror = reject;
      image.onload = () => {
        const scale = Math.min(1, 480 / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderPanel() {
  const list = document.querySelector('#ref-list');
  if (!list) {
    return;
  }

  const entries = Object.entries(OBJECTS);
  const shown = query ? entries.filter(([data]) => matchesQuery(data)) : entries;

  list.innerHTML = shown.length ? shown.map(([data, object]) => `
    <li class="ref-item${data === selected ? ' is-selected' : ''}" data-code="${escapeHtml(data)}"
        style="--accent:${object.color}">
      <strong>${escapeHtml(object.title)}</strong>
      <span class="ref-meta">${escapeHtml(statusFor(data))} · ${notesFor(data).length} note(s)</span>
    </li>`).join('') : '<li class="ref-empty">No object holds that.</li>';

  const form = document.querySelector('#ref-form');
  const heading = document.querySelector('#ref-selected');
  if (selected) {
    form.hidden = false;
    heading.textContent = `Add to: ${objectFor(selected).title}`;
  } else {
    form.hidden = true;
  }
}

function setupPanel() {
  const panel = document.createElement('aside');
  panel.id = 'ref-panel';
  panel.innerHTML = `
    <h1>Object referents</h1>
    <p class="ref-hint">Press a finger on a book's code to select it.</p>
    <input id="ref-search" type="search" placeholder="Search notes → find the book" autocomplete="off">
    <ul id="ref-list"></ul>
    <form id="ref-form" hidden>
      <h2 id="ref-selected"></h2>
      <textarea id="ref-note" rows="3" placeholder="A description, a memory…"></textarea>
      <label class="ref-photo">Photo <input id="ref-image" type="file" accept="image/*"></label>
      <button type="submit">Save</button>
    </form>`;
  document.body.appendChild(panel);

  panel.querySelector('#ref-search').addEventListener('input', (event) => {
    query = event.target.value.trim().toLowerCase();
    renderPanel();
  });

  panel.querySelector('#ref-list').addEventListener('click', (event) => {
    const item = event.target.closest('.ref-item');
    if (item) {
      select(item.dataset.code);
    }
  });

  panel.querySelector('#ref-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const note = panel.querySelector('#ref-note');
    const file = panel.querySelector('#ref-image').files[0];
    const image = file ? await shrinkImage(file) : null;
    addNote(selected, note.value.trim(), image);
    note.value = '';
    panel.querySelector('#ref-image').value = '';
  });

  renderPanel();
  // Keep the "seen … ago" labels current.
  setInterval(renderPanel, 5000);
}

setupPanel();
