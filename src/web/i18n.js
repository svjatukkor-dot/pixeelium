/* Pixelium i18n: uk / en / pl. Функція t(key) + словники.
   Підтримка плюралів для різних мов: formatPlural, pluralPixels, pluralHours. */

export const LANGS = [
  { code: "uk", label: "Українська", short: "UA" },
  { code: "en", label: "English", short: "EN" },
  { code: "pl", label: "Polski", short: "PL" },
];

const uk = {
  title: "Pixelium — стіна пікселів, які можна купити",
  description:
    "Купуйте або орендуйте пікселі на спільній дошці. Оплата USDT (TRC-20), зараховується автоматично.",
  ogTitle: "Pixelium — спільна дошка пікселів",
  ogDescription: "Займи свій шматок дошки: логотип, посилання, реклама. Оплата в USDT.",
  promo: "<b>Дошка відкрита.</b> Перші власники займають найкращі місця — центр і рядки під шапкою.",
  offerBanner: "Дошка відкрита",
  taken: "зайнято",
  free: "вільно",
  admin: "Адмін",
  minePixels: "Мої пікселі",
  login: "Увійти",
  logout: "Вийти",
  heroTitle: "Твій шматок <span class=\"hero-acc\">інтернету</span> — за пікселі",
  heroBody:
    "Стіна з <b id=\"statPixels\">…</b> пікселів. Виділи ділянку, додай логотип і посилання — купи назавжди або візьми в оренду. Оплата в USDT (TRC-20), зараховується автоматично.",
  heroLogin: "Увійти",
  heroBoard: "Дивитись дошку ↓",
  step1: "1 · Увійди",
  step2: "2 · Виділи ділянку",
  step3: "3 · Кастомізуй",
  step4: "4 · Оплати USDT",
  boardHint: "Виділи ділянку і натисни «Кастомізувати» — усе в спливаючому вікні",
  readout: "x:— y:—",
  ariaBoard: "Дошка пікселів",
  reservedNote: "Pixelium · зарезервована зона",
  legendFree: "вільно",
  legendSel: "твоє виділення",
  legendBusy: "зайнято",
  legendBuy: "куплено назавжди",
  footer:
    "Pixelium · USDT TRC-20 · Ціни в USDT. Перевіряй мережу переказу: кошти в іншій мережі повернути неможливо.",
  custTitle: "Кастомізація ділянки",
  fieldTitle: "Заголовок",
  fieldTitlePh: "Мій сайт",
  fieldLink: "Посилання (http/https)",
  fieldImage: "Картинка (URL)",
  fieldColor: "Колір фону",
  modeBuy: "Назавжди",
  modeRent: "Оренда",
  h1: "1 год",
  h24: "1 день",
  h168: "7 днів",
  h720: "30 днів",
  selSummaryDefault: "Виділи пікселі на дошці",
  buy: "Купити",
  loading: "Завантаження…",
  checkout: "Оплата",
  payStep1: "1. Відкрий гаманець і вибери USDT у мережі <b>TRC-20</b>. Адреса:",
  copy: "Копіювати",
  payStep2:
    "2. Надішли<b> рівно цю суму</b> — до останньої цифри після коми. Активація працює лише за точного збігу суми:",
  payWarn:
    "<b>Комісію біржі платить відправник.</b> Біржа віднімає свою комісію від суми переказу — до нашої адреси прийде менше, і оплата <b>не зарахується автоматично</b>. У налаштуваннях переказу обери «комісію платить відправник» (Network fee → sender) або надішли суму плюс комісію згори. Переплата теж не зарахується автоматично — транзакція залишиться без замовлення, адмін-панель показує такі «непривʼязані» перекази для ручного розбору.",
  payStep3: "3. Чекай. Оплата зараховується сама через 1–2 хвилини.",
  manualSummary: "Не зарахувалось? Встав хеш транзакції",
  txPlaceholder: "64 символи TXID",
  verify: "Перевірити оплату",
  mine: "Мої пікселі",
  account: "Кабінет",
  accountTitle: "Особистий кабінет",
  signedInAs: "Ви увійшли як",
  email: "Email",
  myPixels: "Мої пікселі",
  openPixels: "Відкрити",
  copySub: "ID акаунта скопійовано",
  welcome: "Ласкаво просимо до Pixelium!",
  signInPrompt: "Увійдіть через Freebuff, щоб виділяти та купувати пікселі.",
  done: "Готово",
  adminTitle: "Адмін-панель",
  adminReports: "Скарги",
  adminIncoming: "Вхідні TRC-20 перекази (непривʼязані вгорі)",
  adminIncomingHint:
    "«без замовлення» = сума не збігається з жодним незавершеним замовленням — переплати, недоплати і «ці» транзакції треба розібрати вручну.",
  untitled: "Без назви",
  boughtForever: "викуплено назавжди",
  untilText: "до",
  buySelected: "Купити виділене",
  rentNow: "Орендувати",
  loginToBuy: "Увійти, щоб купити",
  copied: "Скопійовано",
  copyFailed: "Не вдалося скопіювати — виділіть текст вручну",
  reportSent: "Скаргу надіслано — модератор перевірить ділянку",
  reportSignIn: "Щоб поскаржитись — увійдіть в акаунт",
  reportBtnTitle: "Поскаржитись: скам, небезпечний вміст, мертве посилання",
  reportReported: "Скаргу надіслано",
  paymentConfirmed: "Оплата підтверджена",
  paymentVerifying: "Перевіряємо транзакцію в блокчейні Tron…",
  paymentTimeExpired: "час вийшов — створіть нове замовлення",
  paymentTimeLeft: "час на оплату:",
  seeOnBoard: "Дивитися на дошці",
  goToBoard: "На дошці",
  bannerOnBoard: "Ваш банер вже на дошці:",
  foreverOwnership: "Ділянка ваша назавжди — вона не зникне і її не можна перехопити.",
  validUntil: "Діє до",
  cancel: "Скасувати",
  orderCancelled: "Замовлення скасовано",
  paint: "Малювати",
  paintAria: "Відкрити піксель-редактор",
  extend: "Продовжити",
  area: "Область",
  areaSize: "Площа",
  period: "Термін",
  amountToPay: "До сплати",
  unpaidOrders: "Неоплачені замовлення",
  activeRentals: "Активні оренди",
  noActiveRentals: "У вас ще немає активних оренд.",
  orderFor: "Замовлення на",
  waitingForPayment: "очікує оплати",
  payAnyway: "Оплатити все одно",
  payNow: "Оплатити",
  permanentArea: "постійна ділянка — не спадає і не перехоплюється",
  timeLeft: "залишилось",
  closeReport: "Закрити скаргу",
  clearArt: "Очистити малюнок",
  artCleared: "Малюнок очищено",
  noOpenReports: "Відкритих скарг немає.",
  noTransfersYet: "Переказів у гаманці ще немає.",
  zoomIn: "Збільшити",
  zoomOut: "Зменшити",
  zoomReset: "Скинути масштаб",
  jumpCoords: "Перейти до координат",
  goBtn: "Перейти",
  enterTxidHint: "Введіть хеш транзакції: рівно 64 символи 0-9 a-f.",
  payNotConfigured: "Прийом оплати ще не налаштовано",
  reservedNotice: "Верхні 10 рядів зарезервовані — виділіть область нижче",
  restoredSelection: "Повернулися до вашого виділення",
  appliedSelection: "Область підставлена — оберіть термін і натисніть «Орендувати»",
  pixelSingular: "піксель",
  pixelFew: "пікселі",
  pixelMany: "пікселів",
  hourSingular: "година",
  hourFew: "години",
  hourMany: "годин",
  bannerHiddenToggle: "Сховати промо-банер",
  bannerToggleSaved: "Налаштування банера збережено",
};

const en = {
  title: "Pixelium — a wall of pixels you can buy",
  description:
    "Buy or rent pixels on a shared board. Paid in USDT (TRC-20), credited automatically.",
  ogTitle: "Pixelium — the shared pixel board",
  ogDescription: "Claim your slice of the board: logo, link, ad. Paid in USDT.",
  promo: "<b>The board is open.</b> Early owners grab the best spots — the centre and rows under the header.",
  offerBanner: "Board is open",
  taken: "taken",
  free: "free",
  admin: "Admin",
  minePixels: "My pixels",
  login: "Sign in",
  logout: "Sign out",
  heroTitle: "Your slice of <span class=\"hero-acc\">the internet</span> — one pixel at a time",
  heroBody:
    "A wall of <b id=\"statPixels\">…</b> pixels. Pick an area, add a logo and a link — buy it forever or rent it by the hour. Paid in USDT (TRC-20), credited automatically.",
  heroLogin: "Sign in",
  heroBoard: "See the board ↓",
  step1: "1 · Sign in",
  step2: "2 · Select an area",
  step3: "3 · Customize",
  step4: "4 · Pay USDT",
  boardHint: "Select an area and hit “Customize” — everything in a popup",
  readout: "x:— y:—",
  ariaBoard: "Pixel board",
  reservedNote: "Pixelium · reserved zone",
  legendFree: "free",
  legendSel: "your selection",
  legendBusy: "taken",
  legendBuy: "bought forever",
  footer:
    "Pixelium · USDT TRC-20 · Prices in USDT. Always double-check the network you send on: funds sent on another network cannot be recovered.",
  custTitle: "Customize your area",
  fieldTitle: "Title",
  fieldTitlePh: "My site",
  fieldLink: "Link (http/https)",
  fieldImage: "Image (URL)",
  fieldColor: "Background colour",
  modeBuy: "Forever",
  modeRent: "Rent",
  h1: "1 h",
  h24: "1 day",
  h168: "7 days",
  h720: "30 days",
  selSummaryDefault: "Select pixels on the board",
  buy: "Buy",
  loading: "Loading…",
  checkout: "Payment",
  payStep1: "1. Open your wallet and pick USDT on the <b>TRC-20</b> network. Address:",
  copy: "Copy",
  payStep2:
    "2. Send<b> exactly this amount</b> — down to the last digit after the decimal point. Activation only works when the amount matches exactly:",
  payWarn:
    "<b>Exchange fees are paid by the sender.</b> Exchanges deduct their fee from the transfer — we would receive less and your payment <b>would not be credited automatically</b>. Choose “sender pays fee” (Network fee → sender) in the transfer settings, or send the amount plus the fee on top. Overpaying is not credited automatically either — the transfer stays unlinked and the admin panel lists such orphaned transfers for manual review.",
  payStep3: "3. Wait. Payments are credited automatically within 1–2 minutes.",
  manualSummary: "Not credited? Paste the transaction hash",
  txPlaceholder: "64-character TXID",
  verify: "Verify payment",
  mine: "My pixels",
  account: "Account",
  accountTitle: "Your account",
  signedInAs: "Signed in as",
  email: "Email",
  myPixels: "My pixels",
  openPixels: "Open",
  copySub: "Account ID copied",
  welcome: "Welcome to Pixelium!",
  signInPrompt: "Sign in via Freebuff to select and buy pixels.",
  done: "Done",
  adminTitle: "Admin panel",
  adminReports: "Reports",
  adminIncoming: "Incoming TRC-20 transfers (unlinked at the top)",
  adminIncomingHint:
    "“no order” = the amount does not match any pending order — overpayments, underpayments and stray transfers need manual review.",
  untitled: "Untitled",
  boughtForever: "bought forever",
  untilText: "until",
  buySelected: "Buy selection",
  rentNow: "Rent",
  loginToBuy: "Sign in to buy",
  copied: "Copied",
  copyFailed: "Failed to copy — please select text manually",
  reportSent: "Report submitted — a moderator will review this area",
  reportSignIn: "Please sign in to submit a report",
  reportBtnTitle: "Report: scam, offensive content, broken link",
  reportReported: "Report submitted",
  paymentConfirmed: "Payment confirmed",
  paymentVerifying: "Verifying transaction on the Tron blockchain…",
  paymentTimeExpired: "time expired — please create a new order",
  paymentTimeLeft: "time to pay:",
  seeOnBoard: "View on board",
  goToBoard: "On board",
  bannerOnBoard: "Your banner is now on the board:",
  foreverOwnership: "The area is yours forever — it will never expire or be taken.",
  validUntil: "Valid until",
  cancel: "Cancel",
  orderCancelled: "Order cancelled",
  paint: "Paint",
  paintAria: "Open pixel art editor",
  extend: "Extend",
  area: "Area",
  areaSize: "Size",
  period: "Duration",
  amountToPay: "Total to pay",
  unpaidOrders: "Unpaid orders",
  activeRentals: "Active rentals",
  noActiveRentals: "You don't have any active rentals yet.",
  orderFor: "Order for",
  waitingForPayment: "waiting for payment",
  payAnyway: "Pay anyway",
  payNow: "Pay",
  permanentArea: "permanent area — never expires or gets replaced",
  timeLeft: "left",
  closeReport: "Resolve report",
  clearArt: "Clear artwork",
  artCleared: "Artwork cleared",
  noOpenReports: "No open reports.",
  noTransfersYet: "No wallet transfers yet.",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomReset: "Reset zoom",
  jumpCoords: "Jump to coordinates",
  goBtn: "Go",
  enterTxidHint: "Enter transaction hash: exactly 64 characters 0-9 a-f.",
  payNotConfigured: "Payment receiving is not configured yet",
  reservedNotice: "Top 10 rows are reserved — please select an area below",
  restoredSelection: "Restored your previous selection",
  appliedSelection: "Area preselected — choose duration and click “Rent”",
  pixelSingular: "pixel",
  pixelFew: "pixels",
  pixelMany: "pixels",
  hourSingular: "hour",
  hourFew: "hours",
  hourMany: "hours",
  bannerHiddenToggle: "Hide promo banner",
  bannerToggleSaved: "Banner settings saved",
};

const pl = {
  title: "Pixelium — ściana pikseli, które można kupić",
  description:
    "Kup lub wynajmij piksele na wspólnej tablicy. Płatność USDT (TRC-20), zaliczana automatycznie.",
  ogTitle: "Pixelium — wspólna tablica pikseli",
  ogDescription: "Zajmij swój kawałek tablicy: logo, link, reklama. Płatność w USDT.",
  promo: "<b>Tablica otwarta.</b> Pierwsi właściciele zajmują najlepsze miejsca — środek i rzędy pod nagłówkiem.",
  offerBanner: "Tablica otwarta",
  taken: "zajęte",
  free: "wolne",
  admin: "Admin",
  minePixels: "Moje piksele",
  login: "Zaloguj się",
  logout: "Wyloguj",
  heroTitle: "Twój kawałek <span class=\"hero-acc\">internetu</span> — za piksele",
  heroBody:
    "Ściana <b id=\"statPixels\">…</b> pikseli. Zaznacz obszar, dodaj logo i link — kup na zawsze albo wynajmij. Płatność w USDT (TRC-20), zaliczana automatycznie.",
  heroLogin: "Zaloguj się",
  heroBoard: "Zobacz tablicę ↓",
  step1: "1 · Zaloguj się",
  step2: "2 · Zaznacz obszar",
  step3: "3 · Dostosuj",
  step4: "4 · Zapłać USDT",
  boardHint: "Zaznacz obszar i kliknij „Dostosuj” — wszystko w wyskakującym oknie",
  readout: "x:— y:—",
  ariaBoard: "Tablica pikseli",
  reservedNote: "Pixelium · strefa zastrzeżona",
  legendFree: "wolne",
  legendSel: "twój wybór",
  legendBusy: "zajęte",
  legendBuy: "kupione na zawsze",
  footer:
    "Pixelium · USDT TRC-20 · Ceny w USDT. Zawsze sprawdzaj sieć przelewu: środków wysłanych inną siecią nie da się odzyskać.",
  custTitle: "Dostosuj obszar",
  fieldTitle: "Tytuł",
  fieldTitlePh: "Moja strona",
  fieldLink: "Link (http/https)",
  fieldImage: "Obrazek (URL)",
  fieldColor: "Kolor tła",
  modeBuy: "Na zawsze",
  modeRent: "Wynajem",
  h1: "1 godz.",
  h24: "1 dzień",
  h168: "7 dni",
  h720: "30 dni",
  selSummaryDefault: "Zaznacz piksele na tablicy",
  buy: "Kup",
  loading: "Ładowanie…",
  checkout: "Płatność",
  payStep1: "1. Otwórz portfel i wybierz USDT w sieci <b>TRC-20</b>. Adres:",
  copy: "Kopiuj",
  payStep2:
    "2. Wyślij<b> dokładnie tę kwotę</b> — do ostatniej cyfry po przecinku. Aktywacja działa tylko przy dokładnym dopasowaniu kwoty:",
  payWarn:
    "<b>Prowizję giełdy płaci nadawca.</b> Giełda odejmuje swoją prowizję od kwoty przelewu — do nas dotrze mniej i płatność <b>nie zostanie zaliczona automatycznie</b>. W ustawieniach przelewu wybierz „prowizję płaci nadawca” (Network fee → sender) albo wyślij kwotę plus prowizję. Nadpłata też nie zostanie zaliczona automatycznie — transakcja pozostanie bez zamówienia, panel admina pokazuje takie „niepowiązane” przelewy do ręcznej weryfikacji.",
  payStep3: "3. Poczekaj. Płatność zalicza się sama w ciągu 1–2 minut.",
  manualSummary: "Nie zaliczono? Wklej hash transakcji",
  txPlaceholder: "64 znaki TXID",
  verify: "Sprawdź płatność",
  mine: "Moje piksele",
  account: "Konto",
  accountTitle: "Twoje konto",
  signedInAs: "Zalogowano jako",
  email: "Email",
  myPixels: "Moje piksele",
  openPixels: "Otwórz",
  copySub: "Skopiowano ID konta",
  welcome: "Witamy w Pixelium!",
  signInPrompt: "Zaloguj się przez Freebuff, aby zaznaczać i kupować piksele.",
  done: "Gotowe",
  adminTitle: "Panel admina",
  adminReports: "Zgłoszenia",
  adminIncoming: "Przychodzące przelewy TRC-20 (niepowiązane na górze)",
  adminIncomingHint:
    "„bez zamówienia” = kwota nie pasuje do żadnego oczekującego zamówienia — nadpłaty, niedopłaty i obce przelewy wymagają ręcznej weryfikacji.",
  untitled: "Bez nazwy",
  boughtForever: "kupione na zawsze",
  untilText: "do",
  buySelected: "Kup wybrane",
  rentNow: "Wynajmij",
  loginToBuy: "Zaloguj się, aby kupić",
  copied: "Skopiowano",
  copyFailed: "Nie udało się skopiować — zaznacz tekst ręcznie",
  reportSent: "Zgłoszenie wysłane — moderator sprawdzi ten obszar",
  reportSignIn: "Zaloguj się, aby przesłać zgłoszenie",
  reportBtnTitle: "Zgłoś: scam, nieodpowiednia treść, niedziałający link",
  reportReported: "Zgłoszenie wysłane",
  paymentConfirmed: "Płatność potwierdzona",
  paymentVerifying: "Sprawdzanie transakcji w blockchainie Tron…",
  paymentTimeExpired: "czas minął — stwórz nowe zamówienie",
  paymentTimeLeft: "czas na płatność:",
  seeOnBoard: "Zobacz na tablicy",
  goToBoard: "Na tablicy",
  bannerOnBoard: "Twój baner jest już na tablicy:",
  foreverOwnership: "Obszar jest Twój na zawsze — nie wygaśnie i nikt go nie przejmie.",
  validUntil: "Ważne do",
  cancel: "Anuluj",
  orderCancelled: "Zamówienie anulowane",
  paint: "Rysuj",
  paintAria: "Otwórz edytor pikseli",
  extend: "Przedłuż",
  area: "Obszar",
  areaSize: "Powierzchnia",
  period: "Okres",
  amountToPay: "Do zapłaty",
  unpaidOrders: "Nieopłacone zamówienia",
  activeRentals: "Aktywne wynajmy",
  noActiveRentals: "Nie masz jeszcze aktywnych wynajmów.",
  orderFor: "Zamówienie na",
  waitingForPayment: "oczekuje na płatność",
  payAnyway: "Zapłać mimo to",
  payNow: "Zapłać",
  permanentArea: "stały obszar — nie wygasa i nie zostanie przejęty",
  timeLeft: "pozostało",
  closeReport: "Zamknij zgłoszenie",
  clearArt: "Wyczyść rysunek",
  artCleared: "Rysunek wyczyszczony",
  noOpenReports: "Brak otwartych zgłoszeń.",
  noTransfersYet: "Brak przelewów w portfelu.",
  zoomIn: "Przybliż",
  zoomOut: "Oddal",
  zoomReset: "Zresetuj skalę",
  jumpCoords: "Przejdź do współrzędnych",
  goBtn: "Przejdź",
  enterTxidHint: "Wprowadź hash transakcji: dokładnie 64 znaki 0-9 a-f.",
  payNotConfigured: "Przyjmowanie płatności nie jest jeszcze skonfigurowane",
  reservedNotice: "Górne 10 rzędów jest zastrzeżonych — zaznacz obszar poniżej",
  restoredSelection: "Przywrócono Twój wybór",
  appliedSelection: "Obszar wstawiony — wybierz okres i kliknij „Wynajmij”",
  pixelSingular: "piksel",
  pixelFew: "piksele",
  pixelMany: "pikseli",
  hourSingular: "godzina",
  hourFew: "godziny",
  hourMany: "godzin",
  bannerHiddenToggle: "Ukryj baner promocyjny",
  bannerToggleSaved: "Zapisano ustawienia banera",
};

export const DICTS = { uk, en, pl };

let current = "uk";

export function t(key) {
  return (
    (DICTS[current] && DICTS[current][key]) ??
    (DICTS.uk && DICTS.uk[key]) ??
    String(key)
  );
}

export function getLang() {
  return current;
}

export function formatPlural(n, one, few, many, lang = current) {
  if (lang === "en") return n === 1 ? one : many;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function pluralPixels(n, lang = current) {
  const dict = DICTS[lang] || DICTS.uk;
  return formatPlural(n, dict.pixelSingular, dict.pixelFew, dict.pixelMany, lang);
}

export function pluralHours(n, lang = current) {
  const dict = DICTS[lang] || DICTS.uk;
  return formatPlural(n, dict.hourSingular, dict.hourFew, dict.hourMany, lang);
}

/** Оновлює всі data-i18n / data-i18n-html елементи + <html lang> і <title>. */
export function applyI18n(lang) {
  current = DICTS[lang] ? lang : "uk";
  try {
    localStorage.setItem("px_lang", current);
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = current;
  const dict = DICTS[current];
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const v = dict[el.dataset.i18n];
    if (typeof v === "string") el.textContent = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-html]")) {
    const v = dict[el.dataset.i18nHtml];
    if (typeof v === "string") el.innerHTML = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-ph]")) {
    const v = dict[el.dataset.i18nPh];
    if (typeof v === "string") el.placeholder = v;
  }
  for (const el of document.querySelectorAll("[data-i18n-label]")) {
    const v = dict[el.dataset.i18nLabel];
    if (typeof v === "string") el.setAttribute("aria-label", v);
  }
  for (const el of document.querySelectorAll("[data-i18n-title]")) {
    const v = dict[el.dataset.i18nTitle];
    if (typeof v === "string") el.setAttribute("title", v);
  }
  document.title = dict.title;
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) metaDesc.setAttribute("content", dict.description);
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute("content", dict.ogTitle);
  const ogDesc = document.querySelector('meta[property="og:description"]');
  if (ogDesc) ogDesc.setAttribute("content", dict.ogDescription);
  return current;
}

/** Автовизначення: збережений вибір → мова браузера → uk. */
export function detectLang() {
  try {
    const saved = localStorage.getItem("px_lang");
    if (saved && DICTS[saved]) return saved;
  } catch {
    /* storage unavailable */
  }
  const nav = (navigator.language || "uk").toLowerCase();
  if (nav.startsWith("uk")) return "uk";
  if (nav.startsWith("pl")) return "pl";
  if (nav.startsWith("en")) return "en";
  return "uk";
}

/** Будує перемикач мов у контейнері (#langSwitch). */
export function mountLangSwitch(container) {
  if (!container) return;
  container.innerHTML = "";
  for (const lang of LANGS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lang-btn";
    btn.textContent = lang.short;
    btn.title = lang.label;
    btn.setAttribute("aria-label", lang.label);
    btn.dataset.lang = lang.code;
    btn.setAttribute("aria-pressed", String(lang.code === current));
    btn.addEventListener("click", () => {
      if (lang.code === getLang()) return;
      /* Add switching animation class before applying */
      btn.classList.add("switching");
      btn.addEventListener("animationend", () => btn.classList.remove("switching"), { once: true });
      applyI18n(lang.code);
      /* Update aria-pressed on ALL buttons in the container */
      for (const b of container.querySelectorAll(".lang-btn")) {
        b.setAttribute("aria-pressed", String(b.dataset.lang === lang.code));
      }
      document.dispatchEvent(new CustomEvent("px:i18n-changed", { detail: { lang: lang.code } }));
    });
    container.append(btn);
  }
}
