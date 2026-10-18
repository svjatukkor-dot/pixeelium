/* Піксель-редактор (фарбування ділянки). Немає залежностей, строго до CSP:
   жодних інлайн-стилів/скриптів, усі обробники — addEventListener.

   Формат даних: масив індексів палітри палітри (0 = прозорий), стиснутий
   RLE (runner-length, пари значення/кількість, максимум 255) в base64url —
   той самий кодек, що й на сервері (src/util.ts). Один піксель дошки =
   один піксель малюнка. */

import { ART_PALETTE } from "./palette.js";

const TRANSPARENT = 0;
const PALETTE_SIZE = ART_PALETTE.length; // 33: прозорий + 32 кольори
const UNDO_LIMIT = 60; // мін. 50 за ТЗ
const ZOOM_MIN = 4;
const ZOOM_MAX = 28;

/* -------------------------------- RLE codec ------------------------------- */

export function encodeArtRle(indexes) {
  const out = [];
  let i = 0;
  while (i < indexes.length) {
    const v = indexes[i];
    if (v >= PALETTE_SIZE) throw new Error("art palette index out of range");
    let run = 1;
    while (i + run < indexes.length && indexes[i + run] === v && run < 255) run++;
    out.push(v, run);
    i += run;
  }
  let bin = "";
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeArtRle(encoded, expectedLen) {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(expectedLen);
  let pos = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const v = bin.charCodeAt(i);
    const run = bin.charCodeAt(i + 1);
    if (v >= PALETTE_SIZE || run < 1 || pos + run > expectedLen) {
      throw new Error("bad art payload");
    }
    out.fill(v, pos, pos + run);
    pos += run;
  }
  if (pos !== expectedLen) throw new Error("art payload length mismatch");
  return out;
}

/* ------------------------------ color helpers ----------------------------- */

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function nearestPaletteIndex(r, g, b) {
  let best = 1;
  let bestDist = Infinity;
  for (let i = 1; i < PALETTE_SIZE; i++) {
    const [pr, pg, pb] = hexToRgb(ART_PALETTE[i]);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function quantizeToPalette(r, g, b, a) {
  if (a < 128) return TRANSPARENT;
  return nearestPaletteIndex(r, g, b);
}

/* ------------------------------ editor widget ----------------------------- */

/**
 * Створює редактор всередині контейнера.
 *   openEditor({ rect, loadArt, saveArt, onDirty })
 * loadArt() -> { data, version } | null ( serves GET /api/rentals/:id/art)
 * saveArt(dataUrl + rle) -> PUT /api/rentals/:id/art
 */
export function openEditor(container, { rect, loadArt, saveArt, onClose }) {
  const { w, h } = rect;
  container.replaceChildren();
  container.classList.add("art-editor");

  /* state */
  let cells = new Uint8Array(w * h); // palette indexes
  let undoStack = [];
  let redoStack = [];
  let currentColor = 1; // чорний за замовчуванням
  let tool = "pencil";
  let zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(90 / Math.max(w, h, 1))));
  let drawing = false;
  let lineStart = null;
  let hoverCell = null;

  /* DOM */
  const canvasWrap = document.createElement("div");
  canvasWrap.className = "art-canvas-wrap";
  const canvas = document.createElement("canvas");
  canvas.className = "art-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    `Піксель-редактор ділянки ${w}×${h}. Малюйте зіскоком або пальцем.`,
  );
  canvas.tabIndex = 0;
  canvasWrap.append(canvas);

  const toolbar = document.createElement("div");
  toolbar.className = "art-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Інструменти малювання");

  const paletteRow = document.createElement("div");
  paletteRow.className = "art-palette";
  paletteRow.setAttribute("role", "radiogroup");
  paletteRow.setAttribute("aria-label", "Палітра кольорів");

  const status = document.createElement("p");
  status.className = "art-status";
  status.setAttribute("aria-live", "polite");

  const actions = document.createElement("div");
  actions.className = "art-actions";

  container.append(canvasWrap, toolbar, paletteRow, actions, status);

  /* ------------------------------ palette UI ----------------------------- */
  const paletteButtons = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "art-swatch" + (i === 0 ? " transparent" : "");
    sw.style.background = i === 0 ? "" : ART_PALETTE[i];
    if (i === 0) sw.classList.add("transparent");
    sw.setAttribute("role", "radio");
    sw.setAttribute("aria-checked", i === currentColor ? "true" : "false");
    sw.setAttribute(
      "aria-label",
      i === 0 ? "Прозорий (ластик)" : `Колір ${ART_PALETTE[i]}`,
    );
    sw.title = i === 0 ? "Прозорий/ластик" : ART_PALETTE[i];
    sw.addEventListener("click", () => {
      currentColor = i;
      for (let j = 0; j < paletteButtons.length; j++) {
        paletteButtons[j].setAttribute("aria-checked", j === i ? "true" : "false");
      }
          // Вибір прозорого перемикає інструмент на ластик — так зручніше.
    if (i === 0 && tool !== "eraser") setTool("eraser");
    else if (i !== 0 && tool === "eraser") setTool("pencil");
    canvas.focus({ preventScroll: true });
    });
    paletteButtons.push(sw);
    paletteRow.append(sw);
  }

  // Власний колір: <input type=color>, квантується до найближчої палітри.
  const customLabel = document.createElement("label");
  customLabel.className = "art-custom";
  customLabel.setAttribute("aria-label", "Власний колір (квантується до палітри)");
  const customInput = document.createElement("input");
  customInput.type = "color";
  customInput.value = "#3b82f6";
  const customCode = document.createElement("code");
  customCode.textContent = "власний";
  customLabel.append(customInput, customCode);
  paletteRow.append(customLabel);
  customInput.addEventListener("input", () => {
    const [r, g, b] = hexToRgb(customInput.value);
    const idx = nearestPaletteIndex(r, g, b);
    customCode.textContent = `→ ${ART_PALETTE[idx]}`;
    currentColor = idx;
    for (let j = 0; j < paletteButtons.length; j++) {
      paletteButtons[j].setAttribute("aria-checked", j === idx ? "true" : "false");
    }
  });

  /* ------------------------------ tools UI ------------------------------- */
  const TOOLS = [
    ["pencil", "Олівець", "✏️"],
    ["eraser", "Ластик", "🧽"],
    ["fill", "Заливка", "🪣"],
    ["picker", "Піпетка", "💧"],
    ["line", "Пряма", "📏"],
    ["rect", "Прямокутник", "▭"],
  ];
  const toolButtons = new Map();
  for (const [name, label, glyph] of TOOLS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost small art-tool";
    b.dataset.tool = name;
    b.textContent = `${glyph} ${label}`;
    b.setAttribute("aria-pressed", name === tool ? "true" : "false");
    b.title = `${label} (${shortcutFor(name)})`;
    b.addEventListener("click", () => setTool(name));
    toolButtons.set(name, b);
    toolbar.append(b);
  }

  function shortcutFor(name) {
    return { pencil: "P", eraser: "E", fill: "F", picker: "I", line: "L", rect: "R" }[name] ?? "";
  }

  function setTool(name) {
    if (!toolButtons.has(name)) return;
    tool = name;
    for (const [n, b] of toolButtons) {
      b.setAttribute("aria-pressed", n === name ? "true" : "false");
    }
    if (name !== "picker") {
      // Логічний звʼязок: ластик = колір 0.
      currentColor = name === "eraser" ? 0 : currentColor === 0 ? 1 : currentColor;
      for (let j = 0; j < paletteButtons.length; j++) {
        paletteButtons[j].setAttribute("aria-checked", j === currentColor ? "true" : "false");
      }
    }
  }

  /* ------------------------------ actions UI ----------------------------- */
  const btnUndo = mkBtn("↩ Скасувати", "Скасувати останню дію (Ctrl+Z)");
  const btnRedo = mkBtn("↪ Повторити", "Повторити скасовану дію (Ctrl+Y)");
  const btnClear = mkBtn("🗑 Очистити", "Прибрати всі пікселі");
  const btnImport = mkBtn("🖼 З файла", "Імпорт картинки з ресайзом і квантуванням (локально у браузері)");
  const btnExport = mkBtn("⬇ PNG", "Експорт у PNG");
  const btnSave = mkBtn("💾 Зберегти", "Зберегти малюнок на сервер (PUТ /api/rentals/:id/art)");
  const btnClose = mkBtn("✕ Закрити", "Закрити редактор");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/png,image/jpeg,image/webp,image/gif";
  fileInput.hidden = true;
  actions.append(btnUndo, btnRedo, btnClear, btnImport, btnExport, btnSave, btnClose, fileInput);

  function mkBtn(text, aria) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost small";
    b.textContent = text;
    if (aria) b.setAttribute("aria-label", aria);
    return b;
  }

  /* ------------------------------ canvas size ---------------------------- */
  function layout() {
    canvas.width = w * zoom;
    canvas.height = h * zoom;
    draw();
  }

  /* ------------------------------ rendering ------------------------------ */
  function draw() {
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    // Прозорий фон — шахівниця.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = cells[y * w + x];
        ctx.fillStyle = idx === TRANSPARENT ? "#20242e" : ART_PALETTE[idx];
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
    }
    // Сітка при достатньому зумі.
    if (zoom >= 10) {
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (let x = 1; x < w; x++) {
        ctx.beginPath();
        ctx.moveTo(x * zoom + 0.5, 0);
        ctx.lineTo(x * zoom + 0.5, canvas.height);
        ctx.stroke();
      }
      for (let y = 1; y < h; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * zoom + 0.5);
        ctx.lineTo(canvas.width, y * zoom + 0.5);
        ctx.stroke();
      }
    }
    if (hoverCell) {
      ctx.strokeStyle = "#7dd3fc";
      ctx.lineWidth = 2;
      ctx.strokeRect(hoverCell.x * zoom + 1, hoverCell.y * zoom + 1, zoom - 2, zoom - 2);
    }
  }

  /* ------------------------------- history ------------------------------- */
  const snapshot = () => new Uint8Array(cells);
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
  }
  btnUndo.addEventListener("click", undo);
  btnRedo.addEventListener("click", redo);
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    cells = undoStack.pop();
    draw();
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    cells = redoStack.pop();
    draw();
  }

  /* ------------------------------ drawing ops ---------------------------- */
  function setCell(x, y, v) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    cells[y * w + x] = v;
  }

  function fillFrom(x, y, target, value) {
    if (target === value) return;
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      if (cells[cy * w + cx] !== target) continue;
      cells[cy * w + cx] = value;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  function drawLine(x0, y0, x1, y1, v) {
    // Bresenham
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      setCell(x0, y0, v);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  function drawRect(x0, y0, x1, y1, v) {
    const lx = Math.min(x0, x1);
    const rx = Math.max(x0, x1);
    const ty = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    for (let x = lx; x <= rx; x++) {
      setCell(x, ty, v);
      setCell(x, by, v);
    }
    for (let y = ty; y <= by; y++) {
      setCell(lx, y, v);
      setCell(rx, y, v);
    }
  }

  /* --------------------------- pointer handling -------------------------- */
  function cellFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * w);
    const y = Math.floor(((e.clientY - r.top) / r.height) * h);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    return { x, y };
  }

  let strokeSnapshot = null;

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const cell = cellFromEvent(e);
    if (!cell) return;
    drawing = true;
    strokeSnapshot = snapshot();
    if (tool === "fill") {
      pushUndo();
      fillFrom(cell.x, cell.y, cells[cell.y * w + cell.x], currentColor);
      draw();
      drawing = false;
    } else if (tool === "picker") {
      const idx = cells[cell.y * w + cell.x];
      if (idx !== TRANSPARENT) {
        currentColor = idx;
        for (let j = 0; j < paletteButtons.length; j++) {
          paletteButtons[j].setAttribute("aria-checked", j === idx ? "true" : "false");
        }
      }
      drawing = false;
    } else if (tool === "line" || tool === "rect") {
      lineStart = cell;
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const cell = cellFromEvent(e);
    hoverCell = cell;
    if (!drawing || !cell) {
      draw();
      return;
    }
    if (tool === "pencil" || tool === "eraser") {
      pushUndoOnce();
      setCell(cell.x, cell.y, tool === "eraser" ? TRANSPARENT : currentColor);
    } else if (tool === "line" || tool === "rect") {
      if (lineStart) {
        // превʼю з моментального знімка
        cells = new Uint8Array(strokeSnapshot);
        drawLine(
          lineStart.x, lineStart.y, cell.x, cell.y,
          tool === "eraser" ? TRANSPARENT : currentColor,
        );
        if (tool === "rect") drawRect(lineStart.x, lineStart.y, cell.x, cell.y, currentColor);
      }
    }
    draw();
  });

  let undoPushedThisStroke = false;
  function pushUndoOnce() {
    if (!undoPushedThisStroke) {
      pushUndo();
      undoPushedThisStroke = true;
    }
  }

  function endStroke(e) {
    if (drawing) {
      undoPushedThisStroke = false;
      lineStart = null;
      drawing = false;
      strokeSnapshot = null;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      draw();
    }
  }
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  canvas.addEventListener("pointerleave", () => {
    hoverCell = null;
    if (!drawing) draw();
  });

  /* touch: двома пальцями — панорама/зум; одним — малювання. */
  canvas.style.touchAction = "none";

  /* ------------------------------ keyboard ------------------------------- */
  canvas.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "z" || e.key === "Z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (e.key === "y" || e.key === "Y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        doSave();
        return;
      }
    }
    const map = { p: "pencil", e: "eraser", f: "fill", i: "picker", l: "line", r: "rect" };
    const t = map[e.key?.toLowerCase()];
    if (t) {
      e.preventDefault();
      setTool(t);
    }
  });

  btnClear.addEventListener("click", () => {
    pushUndo();
    cells = new Uint8Array(w * h);
    draw();
  });

  btnUndo.title = "Скасувати (Ctrl+Z)";
  btnRedo.title = "Повторити (Ctrl+Y)";

  /* ------------------------------ zoom UI -------------------------------- */
  const zoomOut = mkBtn("−", "Зменшити масштаб");
  const zoomIn = mkBtn("+", "Збільшити масштаб");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "art-zoom";
  zoomLabel.textContent = `${zoom}×`;
  toolbar.append(zoomOut, zoomLabel, zoomIn);
  zoomOut.addEventListener("click", () => {
    zoom = Math.max(ZOOM_MIN, zoom - 2);
    zoomLabel.textContent = `${zoom}×`;
    layout();
  });
  zoomIn.addEventListener("click", () => {
    zoom = Math.min(ZOOM_MAX, zoom + 2);
    zoomLabel.textContent = `${zoom}×`;
    layout();
  });

  /* лупа на телефоні: тимчасовий зум при малюванні пальцем */
  let pinchZoom = false;
  // (pointer events з touch-action:none вже дають коректне малювання пальцем;
  //  лупа = кнопки +/−, вони великі й доступні з екрана телефона)

  /* ------------------------------ import/export -------------------------- */
  btnImport.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("Не вдалося прочитати зображення"));
        image.src = url;
      });
      // Ресайз точно у w×h і квантування в палітру — все локально.
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const octx = off.getContext("2d");
      octx.imageSmoothingEnabled = true;
      octx.drawImage(img, 0, 0, w, h);
      const data = octx.getImageData(0, 0, w, h);
      pushUndo();
      for (let i = 0; i < w * h; i++) {
        const [r, g, b, a] = [
          data.data[i * 4],
          data.data[i * 4 + 1],
          data.data[i * 4 + 2],
          data.data[i * 4 + 3],
        ];
        cells[i] = quantizeToPalette(r, g, b, a);
      }
      draw();
      status.textContent = "Імпортовано: картинка ресайзнута й квантована в палітру (локально).";
    } catch (err) {
      status.textContent = err.message;
    } finally {
      URL.revokeObjectURL(url);
      fileInput.value = "";
    }
  });

  btnExport.addEventListener("click", () => {
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const octx = off.getContext("2d");
    for (let i = 0; i < w * h; i++) {
      const idx = cells[i];
      if (idx === TRANSPARENT) continue;
      octx.fillStyle = ART_PALETTE[idx];
      octx.fillRect(i % w, Math.floor(i / w), 1, 1);
    }
    const a = document.createElement("a");
    a.download = `pixelium-${w}x${h}.png`;
    a.href = off.toDataURL("image/png");
    a.click();
  });

  /* --------------------------------- save -------------------------------- */
  let saving = false;
  async function doSave() {
    if (saving) return;
    saving = true;
    btnSave.disabled = true;
    status.textContent = "Зберігаємо…";
    try {
      const data = encodeArtRle(cells);
      await saveArt(data, w, h);
      status.textContent = "Збережено ✓ Зʼявиться на дошці за кілька секунд.";
    } catch (err) {
      status.textContent = `Помилка збереження: ${err.message}`;
    } finally {
      saving = false;
      btnSave.disabled = false;
    }
  }
  btnSave.addEventListener("click", doSave);
  if (onClose) btnClose.addEventListener("click", onClose);

  /* --------------------------------- load -------------------------------- */
  (async () => {
    try {
      const existing = await loadArt();
      if (existing && existing.data) {
        cells = decodeArtRle(existing.data, w * h);
        draw();
        status.textContent = `Завантажено збережений малюнок (v${existing.version ?? 1}).`;
      }
    } catch {
      status.textContent = "Не вдалося завантажити збережений малюнок — почніть новий.";
    }
    layout();
  })();
  layout();

  return { destroy: () => container.replaceChildren() };
}
