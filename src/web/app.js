/* Pixelium front-end. No dependencies, no inline styles/scripts (strict CSP). */

import { openEditor, decodeArtRle } from "./art-editor.js";
import { ART_PALETTE } from "./palette.js";
import {
  applyI18n,
  detectLang,
  getLang,
  mountLangSwitch,
  t,
  formatPlural,
  pluralPixels,
  pluralHours,
} from "./i18n.js";

const GRID_W = 40_000;
const GRID_H = 25_000;
const MICRO = 1_000_000;

const $ = (id) => document.getElementById(id);

const els = {
  board: $("board"),
  scroller: $("boardScroller"),
  cells: $("cellsLayer"),
  hover: $("hoverLayer"),
  sel: $("selLayer"),
  hint: $("boardHint"),
  readout: $("hoverReadout"),
  statTaken: $("statTaken"),
  statFree: $("statFree"),
  inTitle: $("inTitle"),
  inLink: $("inLink"),
  inImage: $("inImage"),
  inColor: $("inColor"),
  colorCode: $("colorCode"),
  priceTotal: $("priceTotal"),
  selSummary: $("selSummary"),
  btnBuy: $("btnBuy"),
  panelNote: $("panelNote"),
  btnLogin: $("btnLogin"),
  btnLogout: $("btnLogout"),
  btnMine: $("btnMine"),
  btnAccount: $("btnAccount"),
  heroLogin: $("heroLogin"),
  heroBoard: $("heroBoard"),
  userChip: $("userChip"),
  userName: $("userName"),
  userPic: $("userPic"),
  toast: $("toast"),
  customize: $("customizeDialog"),
  custTitle: $("custTitle"),
  checkout: $("checkoutDialog"),
  checkoutBody: $("checkoutBody"),
  coSummary: $("coSummary"),
  payAddress: $("payAddress"),
  payAmount: $("payAmount"),
  payTimer: $("payTimer"),
  txHash: $("txHash"),
  btnVerify: $("btnVerify"),
  payStatus: $("payStatus"),
  mine: $("mineDialog"),
  mineBody: $("mineBody"),
  account: $("accountDialog"),
  accountBody: $("accountBody"),
  success: $("successDialog"),
  successBody: $("successBody"),
  hourChips: $("hourChips"),
  modeChips: $("modeChips"),
  reservedBand: $("reservedBand"),
  copyAddr: $("copyAddr"),
  copyAmount: $("copyAmount"),
  promoBanner: $("promoBanner"),
  promoClose: $("promoClose"),
  btnZoomIn: $("btnZoomIn"),
  btnZoomOut: $("btnZoomOut"),
  zoomLevel: $("zoomLevel"),
  jumpForm: $("jumpForm"),
  jumpX: $("jumpX"),
  jumpY: $("jumpY"),
  chkBannerHidden: $("chkBannerHidden"),
};

const state = {
  config: null,
  user: null,
  cells: [],
  /** Map<rentalId, Uint8Array palette indexes> — завантажується з /api/art. */
  arts: new Map(),
  etag: null,
  artEtag: null,
  skew: 0,
  zoomIdx: 2,
  zoomLevels: [2, 4, 6, 10, 16],
  cell: 6,
  width: GRID_W,
  height: GRID_H,
  sel: { x: 0, y: 0, w: 1, h: 1 },
  hours: 24,
  mode: "buy",
  didDrag: false,
  priceMicro: 50_000,
  priceBuyMicro: 2_500_000,
  reservedTop: 10,
  dragging: false,
  dragStart: null,
  order: null,
  payTimerId: null,
  pollTimerId: null,
};

/* --------------------------------- helpers -------------------------------- */

async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options };
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  init.headers = headers;
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Помилка ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function formatUsdt(micro) {
  const whole = Math.floor(micro / MICRO);
  const frac = String(Math.abs(micro % MICRO))
    .padStart(6, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

function plural(n, one, few, many) {
  return formatPlural(n, one, few, many, getLang());
}

/** Декоративна мозаїка в hero: декілька «зайнятих» плиток-прикладів. */
function buildHeroTiles() {
  const wrap = document.getElementById("heroTiles");
  if (!wrap) return;
  const tiles = [
    { l: 6, t: 22, w: 34, h: 22, c: "#5b3df5" },
    { l: 46, t: 10, w: 22, h: 34, c: "#0f9d58" },
    { l: 72, t: 30, w: 22, h: 16, c: "#f59e0b" },
    { l: 18, t: 50, w: 18, h: 18, c: "#0ea5e9" },
    { l: 42, t: 52, w: 28, h: 14, c: "#e11d48" },
    { l: 74, t: 52, w: 18, h: 24, c: "#14b8a6" },
  ];
  for (const x of tiles) {
    const d = document.createElement("div");
    d.className = "hero-tile";
    d.style.left = `${x.l}%`;
    d.style.top = `${x.t}%`;
    d.style.width = `${x.w}%`;
    d.style.height = `${x.h}%`;
    d.style.background = x.c;
    wrap.append(d);
  }
}

function safeUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return url.toString();
  } catch {
    /* invalid */
  }
  return "";
}

/**
 * Валідні картинки завантажуються НЕ напряму з чужого хоста, а через наш воркер
 * /api/img (перевірка типу, ліміт 200 КБ, лише URL з активних ділянок).
 * Тому CSP може бути img-src 'self' data: — чужих хостів у дошки немає.
 */
function imgProxyUrl(value) {
  const clean = safeUrl(value);
  return clean ? `/api/img?url=${encodeURIComponent(clean)}` : "";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatLeft(ms) {
  if (ms <= 0) return "0 хв";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const min = totalMin % 60;
  if (days > 0) return `${days} д ${hours} год`;
  if (hours > 0) return `${hours} год ${min} хв`;
  return `${min} хв`;
}

function serverNow() {
  return Date.now() + state.skew;
}

let toastTimer = null;function toast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`.trim();
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 4200);
}

/* --------------------------------- board ---------------------------------- */

/**
 * Кнопка «Поскаржитись» на кожній ділянці (пункт 4). Всередині плитки,
 * щоб не зламати клік по лінку: stopPropagation + preventDefault.
 */
function appendReportBtn(node, cell) {
  const btn = document.createElement("button");
  btn.className = "report-btn";
  btn.type = "button";
  btn.textContent = "⚑";
  btn.setAttribute("aria-label", t("reportBtnTitle"));
  btn.title = t("reportBtnTitle");
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.user) {
      toast(t("reportSignIn"), "error");
      return;
    }
    reportRental(cell.id, btn);
  });
  node.append(btn);
}

async function reportRental(rentalId, btn) {
  btn.disabled = true;
  btn.setAttribute("aria-label", t("reportReported"));
  try {
    await api(`/api/reports/${rentalId}`, {
      method: "POST",
      body: JSON.stringify({ reason: "other" }),
    });
    toast(t("reportSent"), "success");
    btn.classList.add("reported");
  } catch (err) {
    toast(err.message, "error");
    btn.disabled = false;
  }
}

function scrollToRect(rect, smooth = true) {
  if (!els.scroller) return;
  const targetX = (rect.x + rect.w / 2) * state.cell;
  const targetY = (rect.y + rect.h / 2) * state.cell;
  const scrollerW = els.scroller.clientWidth;
  const scrollerH = els.scroller.clientHeight;
  els.scroller.scrollTo({
    left: Math.max(0, targetX - scrollerW / 2),
    top: Math.max(0, targetY - scrollerH / 2),
    behavior: smooth ? "smooth" : "auto",
  });
}

function setZoom(idx, anchorCenter = true) {
  const levels = state.zoomLevels;
  const nextIdx = Math.max(0, Math.min(levels.length - 1, idx));
  if (nextIdx === state.zoomIdx && state.cell === levels[nextIdx]) return;

  const oldCell = state.cell;
  const centerX = (els.scroller.scrollLeft + els.scroller.clientWidth / 2) / oldCell;
  const centerY = (els.scroller.scrollTop + els.scroller.clientHeight / 2) / oldCell;

  state.zoomIdx = nextIdx;
  state.cell = levels[nextIdx];
  if (els.zoomLevel) els.zoomLevel.textContent = `${state.cell}px`;

  layoutBoard();

  if (anchorCenter) {
    els.scroller.scrollLeft = Math.max(0, centerX * state.cell - els.scroller.clientWidth / 2);
    els.scroller.scrollTop = Math.max(0, centerY * state.cell - els.scroller.clientHeight / 2);
  }
}

function jumpToCoords(x, y) {
  const cx = Math.max(0, Math.min(state.width - 1, Math.round(x) || 0));
  const cy = Math.max(state.reservedTop, Math.min(state.height - 1, Math.round(y) || state.reservedTop));
  setSelection({ x: cx, y: cy, w: state.sel.w, h: state.sel.h });
  scrollToRect({ x: cx, y: cy, w: state.sel.w, h: state.sel.h });
  renderHover({ x: cx, y: cy });
}

function positionFloatBar() {
  const topbar = document.querySelector(".topbar");
  if (topbar) {
    document.documentElement.style.setProperty("--topbar-h", `${topbar.offsetHeight}px`);
  }
}

function layoutBoard() {
  const pxW = state.width * state.cell;
  const pxH = state.height * state.cell;
  els.board.style.width = `${pxW}px`;
  els.board.style.height = `${pxH}px`;
  els.board.style.backgroundSize = `${state.cell * 10}px ${state.cell * 10}px`;
  if (els.reservedBand) {
    els.reservedBand.style.width = `${pxW}px`;
    els.reservedBand.style.height = `${state.reservedTop * state.cell}px`;
  }
  renderCells();
  renderSelection();
}

function renderCells() {
  const frag = document.createDocumentFragment();

  for (const c of state.cells) {
    const href = safeUrl(c.link);
    const node = document.createElement(href ? "a" : "div");
    node.className = "px";
    node.style.left = `${c.x * state.cell}px`;
    node.style.top = `${c.y * state.cell}px`;
    node.style.width = `${c.w * state.cell}px`;
    node.style.height = `${c.h * state.cell}px`;
    node.style.background = c.color || "#1e293b";

    const isBuy = c.mode === "buy" || c.until >= 8_640_000_000_000_000;
    const label =
      `${c.title || t("untitled")} · ` +
      (isBuy ? t("boughtForever") : `${t("untilText")} ${new Date(c.until).toLocaleString(getLang() === "en" ? "en-GB" : getLang() === "pl" ? "pl-PL" : "uk-UA")}`);
    node.title = href ? `${label} · ${href}` : label;

    if (href) {
      node.href = href;
      node.target = "_blank";
      node.rel = "noopener noreferrer nofollow ugc";
    }
    const image = imgProxyUrl(c.image);
    if (image && c.content !== "art") {
      const img = document.createElement("img");
      img.src = image;
      img.alt = c.title || "";
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      node.append(img);
    }
    // Режим «art»: малюнок рендериться шаром під текстом заголовка
    if (c.content === "art" && state.arts instanceof Map && state.arts.has(c.id)) {
      drawArtInto(node, state.arts.get(c.id), c.w, c.h);
    }
    appendReportBtn(node, c);
    frag.append(node);
  }

  els.cells.replaceChildren(frag);
  let taken = 0;
  for (const c of state.cells) taken += c.w * c.h;
  const rentable = state.width * (state.height - state.reservedTop);
  const free = Math.max(0, rentable - taken);
  const loc = getLang() === "en" ? "en-US" : getLang() === "pl" ? "pl-PL" : "uk-UA";
  els.statTaken.textContent = new Intl.NumberFormat(loc).format(taken);
  els.statFree.textContent = new Intl.NumberFormat(loc).format(free);
}

function renderSelection() {
  const { x, y, w, h } = state.sel;
  const box = document.createElement("div");
  box.className = "sel-box";
  box.style.left = `${x * state.cell}px`;
  box.style.top = `${y * state.cell}px`;
  box.style.width = `${w * state.cell}px`;
  box.style.height = `${h * state.cell}px`;
  els.sel.replaceChildren(box);
}

function renderHover(cell) {
  if (els.readout) {
    els.readout.textContent = cell ? `x:${cell.x} y:${cell.y}` : "x:— y:—";
  }
  if (!cell) {
    els.hover.replaceChildren();
    return;
  }
  const box = document.createElement("div");
  box.className = "hover-box";
  box.style.left = `${cell.x * state.cell}px`;
  box.style.top = `${cell.y * state.cell}px`;
  box.style.width = `${state.cell}px`;
  box.style.height = `${state.cell}px`;
  els.hover.replaceChildren(box);
}

function cellAt(clientX, clientY) {
  const rect = els.board.getBoundingClientRect();
  const scaleX = rect.width / state.width;
  const scaleY = rect.height / state.height;
  const cx = Math.min(state.width - 1, Math.max(0, Math.floor((clientX - rect.left) / scaleX)));
  const cy = Math.min(state.height - 1, Math.max(0, Math.floor((clientY - rect.top) / scaleY)));
  return { x: cx, y: cy };
}

function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1,
  };
}

function clampRect(rect) {
  //мін 1, макс 100 — сервер теж обмежує MAX_CELLS_PER_ORDER (10 000 = 100×100),
  //тут лише запобігаємо велетенським виділенням на дошці-гіганті.
  const w = Math.min(Math.min(state.width, 100), Math.max(1, Math.round(rect.w)));
  const h = Math.min(Math.min(state.height, 100), Math.max(1, Math.round(rect.h)));
  const x = Math.min(state.width - w, Math.max(0, Math.round(rect.x)));
  const minY = state.reservedTop;
  const y = Math.min(state.height - h, Math.max(minY, Math.round(rect.y)));
  return { x, y, w, h };
}

function setSelection(rect) {
  state.sel = clampRect(rect);
  renderSelection();
  updatePrice();
}

/* --------------------------------- price ---------------------------------- */

function updatePrice() {
  const cells = state.sel.w * state.sel.h;
  const buy = state.mode === "buy";
  const total = buy ? cells * state.priceBuyMicro : cells * state.hours * state.priceMicro;

  if (els.selSummary) {
    els.selSummary.textContent =
      `x${state.sel.x} y${state.sel.y} · ${state.sel.w}×${state.sel.h} · ` +
      `${cells} ${pluralPixels(cells)}` +
      (buy ? "" : ` · ${state.hours} ${pluralHours(state.hours)}`);
  }
  if (els.priceTotal) els.priceTotal.textContent = `${formatUsdt(total)} USDT`;

  const disabled = !state.config || !state.config.authEnabled;
  els.btnBuy.disabled = disabled;
  els.btnBuy.textContent = state.user
    ? buy
      ? t("buySelected")
      : t("rentNow")
    : t("loginToBuy");

  if (!state.config) {
    els.panelNote.textContent = t("loading");
  } else if (!state.config.authEnabled) {
    els.panelNote.textContent = getLang() === "en"
      ? "Authentication is not configured yet."
      : getLang() === "pl"
        ? "Logowanie nie jest jeszcze skonfigurowane."
        : "Вхід ще не налаштовано — додайте ключі.";
  } else if (!state.user) {
    els.panelNote.textContent = getLang() === "en"
      ? "Sign in to buy or rent pixels."
      : getLang() === "pl"
        ? "Zaloguj się, aby kupować lub wynajmować piksele."
        : "Потрібен вхід в акаунт, щоб купувати пікселі.";
  } else if (!state.config.payAddress) {
    els.panelNote.textContent = t("payNotConfigured");
    els.btnBuy.disabled = true;
  } else {
    els.panelNote.textContent = buy
      ? (getLang() === "en" ? "Click a free pixel to proceed directly to payment." : getLang() === "pl" ? "Kliknij wolny piksel, aby przejść do płatności." : "Клікніть вільний піксель — одразу перейдете до оплати.")
      : (getLang() === "en" ? "Select duration and area, then click “Rent”." : getLang() === "pl" ? "Wybierz okres i obszar, a następnie kliknij „Wynajmij”." : "Оберіть термін, виділіть область і натисніть «Орендувати».");
  }
}

/* --------------------------------- purchase -------------------------------- */

/**
 * Пункт «Кастомізувати»appeared з верхньої частини дошки: виділи область і
 * відкриється спливаюче вікно з увім дочасним URL на малюнку тощо. Перемикає
 * на «customization» замість прямої покупки, щоб весь функціонал жив у
 * спливному вікні.
 */

function coveringCell(x, y) {
  for (const c of state.cells) {
    if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) return c;
  }
  return null;
}

function cellInfoText(c) {
  const isBuy = c.mode === "buy" || c.until >= 8_640_000_000_000_000;
  const name = c.title || t("untitled");
  return isBuy
    ? `${t("boughtForever")} · ${name}`
    : `${t("validUntil")} ${new Date(c.until).toLocaleString(getLang() === "en" ? "en-GB" : getLang() === "pl" ? "pl-PL" : "uk-UA")} · ${name}`;
}

function setHours(hours) {
  const min = state.config?.minHours ?? 1;
  const max = state.config?.maxHours ?? 720;
  state.hours = Math.min(max, Math.max(min, Math.round(hours) || min));
  for (const chip of els.hourChips.querySelectorAll("button")) {
    chip.classList.toggle("active", Number(chip.dataset.hours) === state.hours);
  }
  updatePrice();
}

function setMode(mode) {
  state.mode = mode === "buy" ? "buy" : "rent";
  if (els.hourChips) els.hourChips.hidden = state.mode === "buy";
  if (els.modeChips) {
    for (const chip of els.modeChips.querySelectorAll("button")) {
      chip.classList.toggle("active", chip.dataset.mode === state.mode);
    }
  }
  updatePrice();
}

/**
 * Спливаюче вікно кастомізації (весь функціонал колишньої нижньої док-панелі
 * введено сюди): вміст ділянки + режим/термін + ціна + кнопка покупки.
 * Оновлює заголовок і відкриває діалог; авторизація перевіряється тут.
 */
function openCustomize() {
  if (!els.customize) return;
  const cells = state.sel.w * state.sel.h;
  if (els.custTitle) {
    els.custTitle.textContent =
      `${t("area")} x${state.sel.x} y${state.sel.y} · ${state.sel.w}×${state.sel.h}`;
  }
  if (state.user) {
    els.btnBuy.disabled = !state.config?.payAddress;
    els.btnBuy.textContent = state.mode === "buy" ? t("buySelected") : t("rentNow");
  } else {
    els.btnBuy.disabled = false;
    els.btnBuy.textContent = t("loginToBuy");
  }
  updatePrice();
  if (!els.customize.open) els.customize.showModal();
}

function closeCustomize() {
  if (els.customize?.open) els.customize.close();
}

async function purchaseSelection() {
  if (!state.user) {
    savePendingSelection();
    closeCustomize();
    location.href = "/auth/freebuff/signin?returnTo=/";
    return;
  }
  if (!state.config?.payAddress) {
    toast("Прийом оплати ще не налаштовано", "error");
    return;
  }
  const buy = state.mode === "buy";
  els.btnBuy.disabled = true;
  try {
    const data = await api("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        x: state.sel.x,
        y: state.sel.y,
        w: state.sel.w,
        h: state.sel.h,
        hours: buy ? 0 : state.hours,
        mode: state.mode,
        linkUrl: els.inLink.value,
        imageUrl: els.inImage.value,
        color: els.inColor.value,
      }),
    });
    closeCustomize();
    openCheckout(data.order);
  } catch (err) {
    if (err.status === 401) {
      savePendingSelection();
      closeCustomize();
      location.href = "/auth/freebuff/signin?returnTo=/";
      return;
    }
    toast(err.message, "error");
    if (err.status === 409) loadGrid();
  } finally {
    updatePrice();
  }
}

/* ---------------------------------- user ---------------------------------- */

/**
 * Кабінет користувача (діалог): профіль зі Freebuff (аватар, імʼя, email,
 * sub), кількість активних ділянок, швидкі кнопки «Мої пікселі»/«Вийти».
 * Відкривається кліком по аватару в топбарі та кнопкою «Кабінет» на мобільному.
 */
function openAccount() {
  if (!els.account || !state.user) return;
  const user = state.user;
  const frag = document.createDocumentFragment();

  // --- профіль ---
  const card = document.createElement("div");
  card.className = "acc-card";
  const avatar = document.createElement("img");
  avatar.className = "acc-avatar";
  const proxied = imgProxyUrl(user.picture);
  if (proxied) {
    avatar.src = proxied;
  } else {
    avatar.removeAttribute("src");
    avatar.className = "acc-avatar acc-noimg";
    avatar.textContent = (user.name || "A").charAt(0).toUpperCase();
  }
  const who = document.createElement("div");
  who.className = "acc-who";
  const nm = document.createElement("b");
  nm.textContent = user.name || user.email || "—";
  const em = document.createElement("span");
  em.className = "acc-email";
  em.textContent = user.email || "";
  who.append(nm, em);
  card.append(avatar, who);
  frag.append(card);

  // --- мета ---
  const meta = document.createElement("div");
  meta.className = "acc-meta";
  meta.textContent = `${t("signedInAs")}: ${user.email || user.sub}`;
  frag.append(meta);

  // --- дії ---
  const actions = document.createElement("div");
  actions.className = "acc-actions";
  const btnPixels = document.createElement("button");
  btnPixels.className = "btn primary";
  btnPixels.type = "button";
  btnPixels.textContent = t("myPixels");
  btnPixels.addEventListener("click", () => {
    els.account.close();
    openMine();
  });
  const btnOut = document.createElement("button");
  btnOut.className = "btn ghost";
  btnOut.type = "button";
  btnOut.textContent = t("logout");
  btnOut.addEventListener("click", () => {
    els.account.close();
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/auth/freebuff/signout";
    document.body.append(form);
    form.submit();
  });
  actions.append(btnPixels, btnOut);
  frag.append(actions);

  els.accountBody.replaceChildren(frag);
  if (!els.account.open) els.account.showModal();
}

function renderUser() {
  const user = state.user;
  els.btnLogin.hidden = Boolean(user);
  els.userChip.hidden = !user;
  if (els.btnAccount) els.btnAccount.hidden = !user;
  // Лендінг: після входу герой-секція прибирається — дошка одразу головна.
  if (els.heroLogin) {
    const hero = document.getElementById("hero");
    if (hero) hero.hidden = Boolean(user);
  }
  const admin = $("btnAdmin");
  if (admin) admin.hidden = !(state.config?.adminEnabled && user);
  if (user) {
    els.userName.textContent = user.name || user.email || "Акаунт";
    if (user.picture) {
      const proxied = imgProxyUrl(user.picture);
      if (proxied) {
        els.userPic.src = proxied;
        els.userPic.hidden = false;
      } else {
        els.userPic.hidden = true;
      }
    } else {
      els.userPic.hidden = true;
    }
  }
  positionFloatBar();
}

function savePendingSelection() {
  try {
    localStorage.setItem(
      "px_pending",
      JSON.stringify({
        ...state.sel,
        hours: state.hours,
        title: els.inTitle.value,
        link: els.inLink.value,
        image: els.inImage.value,
        color: els.inColor.value,
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

function restorePendingSelection() {
  try {
    const raw = localStorage.getItem("px_pending");
    if (!raw) return;
    localStorage.removeItem("px_pending");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return;
    setSelection({ x: data.x, y: data.y, w: data.w, h: data.h });
    if (data.hours) setHours(Number(data.hours));
    if (typeof data.title === "string") els.inTitle.value = data.title;
    if (typeof data.link === "string") els.inLink.value = data.link;
    if (typeof data.image === "string") els.inImage.value = data.image;
    if (typeof data.color === "string") {
      els.inColor.value = data.color;
      els.colorCode.textContent = data.color;
    }
    toast(t("restoredSelection"), "success");
  } catch {
    /* ignore */
  }
}

/* --------------------------------- grid ----------------------------------- */

/* --------------------------------- art load ------------------------------- */

/**
 * Публічний пакетний endpoints /api/art (ETag + 304) — не роздуває /api/grid.
 * Малюнки зберігаються в state.arts і рендеряться у renderCells.
 */
async function loadArts() {
  try {
    const headers = {};
    if (state.artEtag) headers["If-None-Match"] = state.artEtag;
    const res = await fetch("/api/art", { headers, credentials: "same-origin" });
    if (res.status === 304) return;
    if (!res.ok) return;
    const data = await res.json();
    state.artEtag = res.headers.get("ETag");
    const fresh = new Map();
    if (Array.isArray(data.arts)) {
      for (const a of data.arts) {
        try {
          fresh.set(a.id, decodeArtRle(a.data, a.w * a.h));
        } catch {
          /* битий payload не має валити рендер дошки */
        }
      }
    }
    state.arts = fresh;
    renderCells();
  } catch {
    /* art is optional decoration — never break the board */
  }
}

/**
 * Малює збережений піксель-арт у елемент ділянки як <canvas> шар під заголовком:
 * заголовок (tooltip) і лінк лишаються поверх, картинка за URL не рендериться
 * у цьому режимі (взаємовиключно, перемикається адміністратором/власником).
 */
function drawArtInto(node, indexes, w, h) {
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  cv.className = "art-layer";
  cv.setAttribute("aria-hidden", "true");
  const ctx = cv.getContext("2d");
  for (let i = 0; i < indexes.length; i++) {
    const idx = indexes[i];
    if (idx === 0) continue; // прозорий
    ctx.fillStyle = ART_PALETTE[idx] || "#1e293b";
    ctx.fillRect(i % w, Math.floor(i / w), 1, 1);
  }
  node.classList.add("has-art");
  node.append(cv);
}

async function loadGrid() {
  try {
    const headers = {};
    if (state.etag) headers["If-None-Match"] = state.etag;
    const res = await fetch("/api/grid", { headers, credentials: "same-origin" });
    if (res.status === 304) return;
    if (!res.ok) throw new Error(`Помилка ${res.status}`);
    const data = await res.json();
    state.etag = res.headers.get("ETag");
    state.skew = Number(data.serverNow) - Date.now();
    state.cells = Array.isArray(data.cells) ? data.cells : [];
    if (data.w) state.width = data.w;
    if (data.h) state.height = data.h;
    if (data.priceMicroPerPixelHour) state.priceMicro = data.priceMicroPerPixelHour;
    if (data.priceMicroPerPixelBuy) state.priceBuyMicro = data.priceMicroPerPixelBuy;
    if (typeof data.reservedTop === "number") {
      state.reservedTop = Math.max(0, Math.min(state.height, data.reservedTop));
    }
    renderCells();
    updatePrice();
  } catch (err) {
    console.warn("grid refresh failed", err);
  }
}

/* -------------------------------- checkout -------------------------------- */

function summaryLine(label, value, total = false) {
  const row = document.createElement("div");
  row.className = total ? "price-line total" : "price-line";
  const left = document.createElement("span");
  left.textContent = label;
  const right = document.createElement("b");
  right.textContent = value;
  row.append(left, right);
  return row;
}

function setStatus(text, kind = "info") {
  els.payStatus.textContent = text;
  els.payStatus.className = `status ${kind}`;
}

function openCheckout(order) {
  state.order = order;

  const summary = document.createDocumentFragment();
  summary.append(
    summaryLine(
      t("area"),
      `x${order.rect.x} y${order.rect.y} · ${order.rect.w}×${order.rect.h}`,
    ),
    summaryLine(
      t("areaSize"),
      `${order.cells} ${pluralPixels(order.cells)}`,
    ),
    summaryLine(
      t("period"),
      order.mode === "buy"
        ? (getLang() === "en" ? "forever (buyout)" : getLang() === "pl" ? "na zawsze (wykup)" : "назавжди (викуп)")
        : `${order.hours} ${pluralHours(order.hours)}`,
    ),
    summaryLine(t("amountToPay"), `${order.amount} USDT`, true),
  );
  els.coSummary.replaceChildren(summary);

  els.payAddress.textContent = order.address || "—";
  els.payAmount.textContent = `${order.amount} USDT`;
  els.txHash.value = "";
  els.btnVerify.disabled = false;
  setStatus("", "info");

  if (!els.checkout.open) els.checkout.showModal();
  startPayTimers();
}

function startPayTimers() {
  stopPayTimers();
  const tick = () => {
    const left = (state.order?.expiresAt ?? 0) - serverNow();
    if (left <= 0) {
      els.payTimer.textContent = t("paymentTimeExpired");
      els.payTimer.classList.add("urgent");
      return;
    }
    const totalSec = Math.floor(left / 1000);
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    els.payTimer.textContent = `${t("paymentTimeLeft")} ${hh > 0 ? `${hh}:` : ""}${pad2(mm)}:${pad2(ss)}`;
    els.payTimer.classList.toggle("urgent", left < 5 * 60 * 1000);
  };
  tick();
  state.payTimerId = setInterval(tick, 1000);

  state.pollTimerId = setInterval(async () => {
    if (!state.order) return;
    try {
      const data = await api(`/api/orders/${state.order.id}`);
      if (data.order.status === "paid") {
        showSuccess(data.order);
      } else if (data.order.status === "expired") {
        els.payTimer.textContent = t("paymentTimeExpired");
        els.payTimer.classList.add("urgent");
      }
    } catch {
      /* keep polling silently */
    }
  }, 5000);
}

function stopPayTimers() {
  if (state.payTimerId) clearInterval(state.payTimerId);
  if (state.pollTimerId) clearInterval(state.pollTimerId);
  state.payTimerId = null;
  state.pollTimerId = null;
}

function showSuccess(order) {
  stopPayTimers();
  if (els.checkout.open) els.checkout.close();
  const until = new Date(order.rentalUntil || order.expiresAt);
  const body = document.createDocumentFragment();

  const hero = document.createElement("div");
  hero.className = "success-hero";
  const mark = document.createElement("div");
  mark.className = "mark";
  mark.textContent = "✓";
  const title = document.createElement("b");
  title.textContent = t("paymentConfirmed");
  const p1 = document.createElement("p");
  p1.textContent = `${t("bannerOnBoard")} x${order.rect.x} y${order.rect.y}, ${order.rect.w}×${order.rect.h}.`;
  const p2 = document.createElement("p");
  p2.textContent =
    order.mode === "buy" || order.rentalUntil >= 8_640_000_000_000_000
      ? t("foreverOwnership")
      : `${t("validUntil")} ${until.toLocaleString(getLang() === "en" ? "en-GB" : getLang() === "pl" ? "pl-PL" : "uk-UA")}.`;
  hero.append(mark, title, p1, p2);

  const btn = document.createElement("button");
  btn.className = "btn primary big";
  btn.type = "button";
  btn.textContent = t("seeOnBoard");
  btn.addEventListener("click", () => {
    els.success.close();
    document.getElementById("boardSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
    scrollToRect(order.rect);
  });

  body.append(hero, btn);
  els.successBody.replaceChildren(body);
  if (!els.success.open) els.success.showModal();

  state.order = null;
  loadGrid();
  els.inTitle.value = "";
  els.inLink.value = "";
  els.inImage.value = "";
}

async function verifyPayment() {
  if (!state.order) return;
  const tx = els.txHash.value.trim();
  if (!/^[0-9a-f]{64}$/i.test(tx)) {
    setStatus(t("enterTxidHint"), "err");
    return;
  }
  els.btnVerify.disabled = true;
  setStatus(t("paymentVerifying"), "info");
  try {
    const data = await api(`/api/orders/${state.order.id}/pay`, {
      method: "POST",
      body: JSON.stringify({ txHash: tx.toLowerCase() }),
    });
    if (data.ok) {
      setStatus(t("paymentConfirmed"), "ok");
      showSuccess(data.order);
    }
  } catch (err) {
    const hint =
      err.status === 404
        ? " " + (getLang() === "en" ? "Transaction not confirmed yet — wait ~30 seconds and retry." : "Транзакція ще не з'явилася або не підтверджена — зачекайте ~30 секунд і повторіть.")
        : err.status === 402
          ? " " + (getLang() === "en" ? "Amount transferred is less than required." : "Сума переказу менша за потрібну.")
          : "";
    setStatus(`${err.message}${hint}`, "err");
    els.btnVerify.disabled = false;
  }
}

/* ------------------------------ my rentals -------------------------------- */

function rentalItem(rental) {
  const li = document.createElement("li");

  const info = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = rental.title || `x${rental.rect.x} y${rental.rect.y}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${rental.rect.w}×${rental.rect.h} · ${rental.cells} ${pluralPixels(rental.cells)} · `;

  const isBuy = rental.mode === "buy" || rental.until >= 8_640_000_000_000_000;
  if (isBuy) {
    meta.textContent += t("boughtForever");
    const left = document.createElement("div");
    left.className = "countdown";
    left.textContent = t("permanentArea");
    info.append(title, meta, left);
  } else {
    const left = document.createElement("div");
    left.className = "countdown";
    left.textContent = `${t("timeLeft")} ${formatLeft(rental.until - serverNow())}`;
    info.append(title, meta, left);
  }

  const btn = document.createElement("button");
  btn.className = "btn ghost small";
  btn.type = "button";
  btn.textContent = isBuy ? t("goToBoard") : t("extend");
  btn.addEventListener("click", () => {
    setSelection(rental.rect);
    if (els.inTitle.value === "" && rental.title) els.inTitle.value = rental.title;
    setHours(state.hours);
    els.mine.close();
    document.getElementById("boardSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
    scrollToRect(rental.rect);
    toast(t("appliedSelection"), "success");
  });

  const btnPaint = document.createElement("button");
  btnPaint.className = "btn ghost small";
  btnPaint.type = "button";
  btnPaint.textContent = t("paint");
  btnPaint.setAttribute("aria-label", `${t("paintAria")} ${rental.rect.w}×${rental.rect.h}`);
  btnPaint.addEventListener("click", () => openArtEditor(rental));

  li.append(info, btnPaint, btn);
  return li;
}

function orderItem(order) {
  const li = document.createElement("li");
  const info = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = `${t("orderFor")} ${order.amount} USDT`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `x${order.rect.x} y${order.rect.y} · ${order.rect.w}×${order.rect.h} · ${
    order.hours
  } ${pluralHours(order.hours)} · ${order.status === "expired" ? t("paymentTimeExpired") : t("waitingForPayment")}`;
  info.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "order-actions";

  const btnPay = document.createElement("button");
  btnPay.className = "btn primary small";
  btnPay.type = "button";
  btnPay.textContent = order.status === "expired" ? t("payAnyway") : t("payNow");
  btnPay.addEventListener("click", () => {
    els.mine.close();
    openCheckout(order);
  });
  actions.append(btnPay);

  if (order.status === "pending") {
    const btnCancel = document.createElement("button");
    btnCancel.className = "btn ghost small";
    btnCancel.type = "button";
    btnCancel.textContent = t("cancel");
    btnCancel.addEventListener("click", async () => {
      btnCancel.disabled = true;
      try {
        await api(`/api/orders/${order.id}/cancel`, { method: "POST", body: JSON.stringify({}) });
        toast(t("orderCancelled"), "success");
        li.remove();
        loadGrid();
      } catch (err) {
        toast(err.message, "error");
        btnCancel.disabled = false;
      }
    });
    actions.append(btnCancel);
  }

  li.append(info, actions);
  return li;
}

async function openMine() {
  if (!state.user) {
    savePendingSelection();
    location.href = "/auth/freebuff/signin?returnTo=/";
    return;
  }
  const body = document.createDocumentFragment();
  const loading = document.createElement("p");
  loading.className = "empty";
  loading.textContent = t("loading");
  body.append(loading);
  els.mineBody.replaceChildren(body);
  if (!els.mine.open) els.mine.showModal();

  try {
    const data = await api("/api/mine");
    state.skew = Number(data.serverNow) - Date.now();
    const frag = document.createDocumentFragment();

    if (data.rentals.length === 0 && data.pending.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = t("noActiveRentals");
      frag.append(empty);
    } else {
      if (data.pending.length > 0) {
        const h = document.createElement("b");
        h.textContent = t("unpaidOrders");
        frag.append(h);
        const list = document.createElement("ul");
        list.className = "list";
        for (const order of data.pending) list.append(orderItem(order));
        frag.append(list);
      }
      if (data.rentals.length > 0) {
        const h = document.createElement("b");
        h.textContent = t("activeRentals");
        frag.append(h);
        const list = document.createElement("ul");
        list.className = "list";
        for (const rental of data.rentals) list.append(rentalItem(rental));
        frag.append(list);
      }
    }
    els.mineBody.replaceChildren(frag);
  } catch (err) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = err.message;
    els.mineBody.replaceChildren(p);
  }
}

/* --------------------------------- admin ----------------------------------- */

/**
 * Адмін-сторінка (діалог): відкриті скарги користувачів (пункт 4) і список
 * вхідних TRC-20 переказів, які не привʼязались до жодного замовлення (пункт 5).
 */
let adminDialog = null;

function ensureAdminDialog() {
  if (adminDialog) return adminDialog;
  adminDialog = $("adminDialog");
  if (!adminDialog) return null;
  const xb = adminDialog.querySelector("[data-close]");
  if (xb) xb.addEventListener("click", () => adminDialog.close());
  adminDialog.addEventListener("click", (e) => {
    if (e.target === adminDialog) adminDialog.close();
  });
  return adminDialog;
}

function adminRow(label, value, cls = "") {
  const span = document.createElement("span");
  span.className = `admin-kv ${cls}`.trim();
  const b = document.createElement("b");
  b.textContent = label;
  span.append(b, ` ${value}`);
  return span;
}

function fmtAmount(micro) {
  const n = Number(micro);
  return Number.isSafeInteger(n) ? `${formatUsdt(n)} USDT` : "—";
}

async function openAdmin() {
  const dialog = ensureAdminDialog();
  if (!dialog) return;
  const rep = $("adminReports");
  const inc = $("adminIncoming");
  rep.textContent = t("loading");
  inc.textContent = t("loading");

  if (els.chkBannerHidden) {
    els.chkBannerHidden.checked = Boolean(state.config?.bannerHidden);
    els.chkBannerHidden.onchange = async () => {
      try {
        const hidden = els.chkBannerHidden.checked;
        await api("/api/admin/banner", {
          method: "POST",
          body: JSON.stringify({ hidden }),
        });
        if (state.config) state.config.bannerHidden = hidden;
        if (els.promoBanner) els.promoBanner.hidden = hidden;
        toast(t("bannerToggleSaved"), "success");
      } catch (err) {
        els.chkBannerHidden.checked = !els.chkBannerHidden.checked;
        toast(err.message, "error");
      }
    };
  }

  if (!dialog.open) dialog.showModal();

  const [reports, incoming] = await Promise.allSettled([
    api("/api/admin/reports"),
    api("/api/admin/incoming"),
  ]);

  // Скарги (пункт 4)
  if (reports.status === "fulfilled") {
    const list = reports.value.reports || [];
    if (list.length === 0) {
      rep.textContent = t("noOpenReports");
    } else {
      rep.replaceChildren(...list.map((r) => {
        const item = document.createElement("div");
        item.className = "admin-item";
        const head = document.createElement("div");
        head.append(
          adminRow("№", r.id),
          adminRow(t("area"), `${r.rental_id ? r.rental_id.slice(0, 8) : "—"}…`),
          adminRow(
            t("areaSize"),
            r.x != null ? `x${r.x} y${r.y} ${r.w}×${r.h}` : "(деактивована)",
          ),
          adminRow("причина", r.reason || "—"),
        );

        const actions = document.createElement("div");
        actions.className = "admin-actions-cell";

        if (r.x != null && r.w != null && r.h != null) {
          const btnShow = document.createElement("button");
          btnShow.className = "btn ghost small";
          btnShow.type = "button";
          btnShow.textContent = t("goToBoard");
          btnShow.addEventListener("click", () => {
            dialog.close();
            jumpToCoords(r.x, r.y);
            setSelection({ x: r.x, y: r.y, w: r.w, h: r.h });
          });
          actions.append(btnShow);
        }

        const btnClear = document.createElement("button");
        btnClear.className = "btn ghost small";
        btnClear.type = "button";
        btnClear.textContent = t("clearArt");
        btnClear.addEventListener("click", async () => {
          try {
            await api(`/api/admin/art/${r.rental_id}`, { method: "DELETE" });
            toast(t("artCleared"), "success");
            loadArts();
          } catch (err) {
            toast(err.message, "error");
          }
        });
        actions.append(btnClear);

        const btn = document.createElement("button");
        btn.className = "btn small";
        btn.type = "button";
        btn.textContent = t("closeReport");
        btn.addEventListener("click", async () => {
          try {
            await api(`/api/admin/reports/${r.id}/resolve`, { method: "POST", body: JSON.stringify({}) });
            item.remove();
            if (!rep.querySelector(".admin-item")) rep.textContent = t("noOpenReports");
            loadGrid();
          } catch (err) {
            toast(err.message, "error");
          }
        });
        actions.append(btn);

        item.append(head, actions);
        return item;
      }));
    }
  } else {
    rep.textContent = `Помилка: ${reports.reason?.message ?? "невідома"}`;
  }

  // Непривʼязані перекази (пункт 5)
  if (incoming.status === "fulfilled") {
    const list = incoming.value.transfers || [];
    if (list.length === 0) {
      inc.textContent = t("noTransfersYet");
    } else {
      inc.replaceChildren(...list.map((tItem) => {
        const item = document.createElement("div");
        item.className = `admin-item status-${tItem.status}`;
        const head = document.createElement("div");
        const statusLabel = {
          unmatched: "⚠ без замовлення",
          pending: "→ зарахується сам (amount збігається)",
          used: "✓ привʼязаний",
        }[tItem.status] || tItem.status;
        head.className = "admin-tx";
        head.append(
          adminRow("tx", tItem.txHash.slice(0, 12) + "…"),
          adminRow("сума", fmtAmount(tItem.value)),
          adminRow("статус", statusLabel, tItem.status),
        );
        if (tItem.blockTimestamp) {
          head.append(
            adminRow("дата", new Date(tItem.blockTimestamp).toLocaleString(getLang() === "en" ? "en-GB" : getLang() === "pl" ? "pl-PL" : "uk-UA")),
          );
        }
        item.append(head);
        return item;
      }));
    }
  } else {
    inc.textContent = `Помилка: ${incoming.reason?.message ?? "невідома"}`;
  }
}

/* ------------------------------ pixel-art editor --------------------------- */

let artDialog = null;

function ensureArtDialog() {
  if (artDialog) return artDialog;
  artDialog = document.createElement("dialog");
  artDialog.className = "modal art-modal";
  const head = document.createElement("div");
  head.className = "modal-head";
  const h = document.createElement("h3");
  h.textContent = "Малюнок ділянки";
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.setAttribute("aria-label", "Закрити");
  x.textContent = "✕";
  x.addEventListener("click", () => artDialog.close());
  head.append(h, x);
  const body = document.createElement("div");
  body.className = "modal-body art-body";
  artDialog.append(head, body);
  artDialog.addEventListener("click", (event) => {
    if (event.target === artDialog) artDialog.close();
  });
  document.body.append(artDialog);
  return artDialog;
}

async function openArtEditor(rental) {
  const dialog = ensureArtDialog();
  const body = dialog.querySelector(".art-body");
  body.textContent = "Завантаження…";
  if (!dialog.open) dialog.showModal();

  let loaded = null;
  try {
    loaded = await api(`/api/rentals/${rental.id}/art`);
  } catch (err) {
    body.textContent = `Не вдалося відкрити редактор: ${err.message}`;
    return;
  }

  const modeRow = document.createElement("div");
  modeRow.className = "art-mode-row";
  const modeLabel = document.createElement("span");
  modeLabel.textContent = "Що показувати на дошці: ";
  const modeImage = mkModeBtn("Картинка (URL)", "image");
  const modeArt = mkModeBtn("Малюнок (піксель-арт)", "art");
  modeRow.append(modeLabel, modeImage, modeArt);
  function mkModeBtn(text, mode) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost small art-mode-btn";
    b.dataset.mode = mode;
    b.textContent = text;
    b.setAttribute("aria-pressed", rental.content === mode ? "true" : "false");
    b.addEventListener("click", async () => {
      try {
        await api(`/api/rentals/${rental.id}/content-mode`, {
          method: "PUT",
          body: JSON.stringify({ mode }),
        });
        rental.content = mode;
        for (const btn of modeRow.querySelectorAll("button")) {
          btn.setAttribute("aria-pressed", btn.dataset.mode === mode ? "true" : "false");
        }
        toast(mode === "art" ? "На дошці тепер показуємо малюнок" : "На дошці тепер показуємо картинку", "success");
        loadGrid();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    return b;
  }

  const editorHost = document.createElement("div");
  body.replaceChildren(modeRow, editorHost);

  openEditor(editorHost, {
    rect: rental.rect,
    loadArt: () => (loaded && loaded.art ? loaded.art : null),
    saveArt: async (data) => {
      const res = await api(`/api/rentals/${rental.id}/art`, {
        method: "PUT",
        body: JSON.stringify({ data, w: rental.rect.w, h: rental.rect.h }),
      });
      // Перший успішний сейв дає режим «art», але не примусово: зберігаємо
      // вибір користувача. Якщо ще не було малюнка, підказуємо.
      if (rental.content !== "art" && !loaded?.art) {
        toast("Малюнок збережено. Щоб показати його на дошці — увімкніть «Малюнок (піксель-арт)» зверху.", "success");
        loaded = { art: { version: res.version } };
      }
      loaded = { ...(loaded ?? {}), art: { ...(loaded?.art ?? {}), version: res.version, data } };
    },
    onClose: () => dialog.close(),
  });
}

/* --------------------------------- events --------------------------------- */

function bindEvents() {
  const activePointers = new Map();
  let pinchStartDist = 0;

  els.board.addEventListener("pointerdown", (event) => {
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size === 1) {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      try {
        els.board.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      state.dragging = true;
      state.didDrag = false;
      state.dragStart = cellAt(event.clientX, event.clientY);
      if (state.dragStart.y < state.reservedTop) {
        state.dragging = false;
        state.dragStart = null;
        toast(t("reservedNotice"), "error");
        return;
      }
      setSelection(rectFromPoints(state.dragStart, state.dragStart));
      els.board.focus({ preventScroll: true });
    } else if (activePointers.size === 2) {
      // 2 fingers: cancel single-touch selection drag and switch to pan/pinch
      state.dragging = false;
      state.dragStart = null;
      const pts = Array.from(activePointers.values());
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  });

  els.board.addEventListener("pointermove", (event) => {
    if (activePointers.has(event.pointerId)) {
      const prev = activePointers.get(event.pointerId);
      activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (activePointers.size >= 2) {
        // Multi-touch drag: pan the scroller
        const dx = event.clientX - prev.x;
        const dy = event.clientY - prev.y;
        els.scroller.scrollLeft -= dx;
        els.scroller.scrollTop -= dy;

        // Pinch zoom
        const pts = Array.from(activePointers.values());
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinchStartDist > 0) {
          const ratio = dist / pinchStartDist;
          if (ratio > 1.35) {
            setZoom(state.zoomIdx + 1);
            pinchStartDist = dist;
          } else if (ratio < 0.75) {
            setZoom(state.zoomIdx - 1);
            pinchStartDist = dist;
          }
        }
        return;
      }
    }

    const current = cellAt(event.clientX, event.clientY);
    renderHover(current);
    if (state.dragging && state.dragStart) {
      if (current.x !== state.dragStart.x || current.y !== state.dragStart.y) {
        state.didDrag = true;
      }
      setSelection(rectFromPoints(state.dragStart, current));
    }
  });

  const endDrag = (event) => {
    activePointers.delete(event.pointerId);
    if (!state.dragging) return;
    state.dragging = false;
    const moved = state.didDrag;
    state.didDrag = false;
    state.dragStart = null;
    try {
      els.board.releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    if (moved) return; // drag-select: keep selection, open the customize dialog
    const cell = cellAt(event.clientX, event.clientY);
    const owner = coveringCell(cell.x, cell.y);
    if (owner) {
      toast(cellInfoText(owner));
      return;
    }
    // single click on a free pixel: open the customization dialog
    openCustomize();
  };
  els.board.addEventListener("pointerup", endDrag);
  els.board.addEventListener("pointercancel", endDrag);
  els.board.addEventListener("pointerleave", () => renderHover(null));

  // Keyboard navigation on board
  els.board.addEventListener("keydown", (e) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_", "Enter", " "].includes(e.key)) {
      e.preventDefault();
    }
    if (e.key === "ArrowLeft") jumpToCoords(state.sel.x - 1, state.sel.y);
    else if (e.key === "ArrowRight") jumpToCoords(state.sel.x + 1, state.sel.y);
    else if (e.key === "ArrowUp") jumpToCoords(state.sel.x, state.sel.y - 1);
    else if (e.key === "ArrowDown") jumpToCoords(state.sel.x, state.sel.y + 1);
    else if (e.key === "+" || e.key === "=") setZoom(state.zoomIdx + 1);
    else if (e.key === "-" || e.key === "_") setZoom(state.zoomIdx - 1);
    else if (e.key === "Enter" || e.key === " ") openCustomize();
  });

  if (els.jumpForm) {
    els.jumpForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const x = Number(els.jumpX?.value ?? 0);
      const y = Number(els.jumpY?.value ?? 0);
      jumpToCoords(x, y);
    });
  }
  if (els.btnZoomIn) {
    els.btnZoomIn.addEventListener("click", () => setZoom(state.zoomIdx + 1));
  }
  if (els.btnZoomOut) {
    els.btnZoomOut.addEventListener("click", () => setZoom(state.zoomIdx - 1));
  }

  if (els.modeChips) {
    for (const chip of els.modeChips.querySelectorAll("button")) {
      chip.addEventListener("click", () => setMode(chip.dataset.mode));
    }
  }
  for (const chip of els.hourChips.querySelectorAll("button")) {
    chip.addEventListener("click", () => setHours(Number(chip.dataset.hours)));
  }

  els.inColor.addEventListener("input", () => {
    els.colorCode.textContent = els.inColor.value;
  });

  els.btnBuy.addEventListener("click", () => purchaseSelection());

  els.btnLogin.addEventListener("click", () => {
    savePendingSelection();
    location.href = "/auth/freebuff/signin?returnTo=/";
  });

  // Кнопка виходу тепер у кабінеті (openAccount); btnLogout лишився для сумісності.
  els.btnLogout?.addEventListener("click", () => {
    // Вихід через Freebuff: POST-форма (не лінк), потім перезавантаження.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/auth/freebuff/signout";
    document.body.append(form);
    form.submit();
  });

  els.btnMine.addEventListener("click", openMine);
  // Кабінет: клік по аватару в топбарі або кнопка «Кабінет».
  els.userChip?.addEventListener("click", openAccount);
  if (els.btnAccount) els.btnAccount.addEventListener("click", openAccount);
  if (els.heroLogin) {
    els.heroLogin.addEventListener("click", () => {
      savePendingSelection();
      location.href = "/auth/freebuff/signin?returnTo=/";
    });
  }
  if (els.heroBoard) {
    els.heroBoard.addEventListener("click", () => {
      document.getElementById("boardSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const btnAdmin = $("btnAdmin");
  if (btnAdmin) btnAdmin.addEventListener("click", openAdmin);
  els.btnVerify.addEventListener("click", verifyPayment);

  if (els.promoClose) {
    els.promoClose.addEventListener("click", () => {
      els.promoBanner.hidden = true;
    });
  }

  els.copyAddr.addEventListener("click", () => copyText(els.payAddress.textContent));
  els.copyAmount.addEventListener("click", () => copyText(els.payAmount.textContent));

  for (const dialog of [els.checkout, els.mine, els.success, els.customize]) {
    if (!dialog) continue;
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    const closeBtn = dialog.querySelector("[data-close]");
    if (closeBtn) closeBtn.addEventListener("click", () => dialog.close());
  }
  els.checkout.addEventListener("close", stopPayTimers);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      positionFloatBar();
      layoutBoard();
    }, 150);
  });
}

async function copyText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast(t("copied"), "success");
  } catch {
    toast(t("copyFailed"), "error");
  }
}

/* ---------------------------------- init ---------------------------------- */

function reportAuthResult() {
  const params = new URLSearchParams(location.search);
  const flag = params.get("auth");
  if (!flag) return;
  params.delete("auth");
  const query = params.toString();
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  if (flag === "ok") {
    toast(state.user?.name ? `${t("welcome")}, ${state.user.name}!` : t("welcome"), "success");
  } else if (flag === "denied") {
    toast(t("cancel"), "error");
  } else if (flag === "failed") {
    toast(t("copyFailed") || "Помилка авторизації", "error");
  }
}

async function init() {
  applyI18n(detectLang());
  mountLangSwitch(document.getElementById("langSwitch"));
  document.addEventListener("px:i18n-changed", () => {
    updatePrice();
    positionFloatBar();
    // applyI18n перезаписує hero-абзац разом з <b id=statPixels> —
    // повертаємо свіже число після кожної зміни мови.
    const statPixels = document.getElementById("statPixels");
    if (statPixels) {
      const avail = state.width * (state.height - state.reservedTop);
      const loc = getLang() === "en" ? "en-US" : getLang() === "pl" ? "pl-PL" : "uk-UA";
      statPixels.textContent = new Intl.NumberFormat(loc).format(avail);
    }
  });
  buildHeroTiles();
  bindEvents();
  setHours(24);
  setSelection({ x: 0, y: 0, w: 10, h: 10 });

  try {
    const [config, me] = await Promise.all([api("/api/config"), api("/api/me")]);
    state.config = config;
    state.user = me.user;
    if (config.grid) {
      state.width = config.grid.w;
      state.height = config.grid.h;
    }
    if (config.priceMicroPerPixelHour) state.priceMicro = config.priceMicroPerPixelHour;
    state.skew = Number(config.serverNow) - Date.now();
      if (els.promoBanner && config.bannerHidden) els.promoBanner.hidden = true;
    if (config.grid) {
      // П.1: кількість доступних пікселів = GRID_W × (GRID_H − RESERVED_TOP_ROWS),
      //   лише з конфігу — жодних захардкоджених чисел у текстах.
      const avail = config.grid.w * (config.grid.h - (config.grid.reservedTop ?? 0));
      const statPixels = document.getElementById("statPixels");
      if (statPixels) statPixels.textContent = new Intl.NumberFormat(getLang() === "en" ? "en-US" : getLang() === "pl" ? "pl-PL" : "uk-UA").format(avail);
      const statFreeCaption = els.statFree?.parentElement;
      if (statFreeCaption) statFreeCaption.title = `${avail} ${"пікселів доступно для покупки й оренди"}`;
    }
    renderUser();
  } catch (err) {
    toast(`Не вдалося завантажити конфіг: ${err.message}`, "error");
  }

  positionFloatBar();
  layoutBoard();
  await loadGrid();
  loadArts();
  restorePendingSelection();
  renderUser();
  updatePrice();
  reportAuthResult();

  setInterval(loadGrid, 15000);
  setInterval(loadArts, 30000);
}

init();
