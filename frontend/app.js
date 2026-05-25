(function ngrokVisitSiteAutoClick() {
  const intervalMs = 50;
  const maxDurationMs = 15000;
  const started = Date.now();

  function findNgrokBypassClickTarget() {
    const sel =
      "a, button, [role='button'], input[type='button'], input[type='submit']";
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      const text = String(el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      const cls = String(
        typeof el.className === "string"
          ? el.className
          : el.getAttribute("class") || ""
      ).toLowerCase();
      if (text.includes("visit site") || cls.includes("bypass")) {
        return el;
      }
    }
    return null;
  }

  let intervalId = null;

  function tick() {
    try {
      if (Date.now() - started > maxDurationMs) {
        if (intervalId != null) clearInterval(intervalId);
        intervalId = null;
        return;
      }
      const target = findNgrokBypassClickTarget();
      if (target) {
        target.click();
        if (intervalId != null) clearInterval(intervalId);
        intervalId = null;
      }
    } catch {
      /* не ломаем страницу */
    }
  }

  tick();
  intervalId = setInterval(tick, intervalMs);
})();

document.addEventListener("DOMContentLoaded", () => {
  if (typeof hideAdminPanelToggle === "function") {
    hideAdminPanelToggle();
  }

  const clearBackgrounds = () => {
    document.documentElement.style.setProperty(
      "background",
      "transparent",
      "important"
    );
    document.documentElement.style.setProperty(
      "background-color",
      "transparent",
      "important"
    );
    document.body.style.setProperty("background", "transparent", "important");
    document.body.style.setProperty(
      "background-color",
      "transparent",
      "important"
    );

    const root =
      document.getElementById("app-root") ||
      document.querySelector(".main-container");
    if (root) {
      root.style.setProperty("background", "transparent", "important");
      root.style.setProperty("background-color", "transparent", "important");
    }
  };

  clearBackgrounds();
  setInterval(() => scheduleNonCriticalTask(clearBackgrounds), 300);
});

/**
 * Халяль Маркет — Telegram Mini App (отказоустойчивый каталог + корзина).
 */

window.STORE_DATA = { categories: [], products: [] };
const CATALOG_LS_KEY = "halal_store_catalog_v14";
const BANNER_LS_KEY = "halal_banner_path_v1";
window.ADMIN_MODE_ACTIVE = false;
window.currentAdminUnitType = "pcs";
window.imageCache = new Map();
window.preloadQueue = [];
window.isPreloading = false;
window.allProducts = [];
window.allCategories = [];

// Inline products.json из index.html — первый рендер без fetch /api/products
if (window.__INITIAL_PRODUCTS__ && typeof window.__INITIAL_PRODUCTS__ === "object") {
  window.__HAS_INITIAL_PRODUCTS__ = true;
  window.STORE_DATA = normalizePayload(window.__INITIAL_PRODUCTS__);
  ensureStoreShape();
  window.allProducts = window.STORE_DATA.products;
  window.allCategories = window.STORE_DATA.categories;
  try {
    localStorage.setItem(
      CATALOG_LS_KEY,
      JSON.stringify({
        categories: window.STORE_DATA.categories,
        products: window.STORE_DATA.products,
      })
    );
  } catch {
    /* quota / private mode */
  }
}

function scheduleNonCriticalTask(fn) {
  if (window.requestIdleCallback) {
    window.requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 100);
  }
}
window.scheduleNonCriticalTask = scheduleNonCriticalTask;

const DEFAULT_PRODUCT_IMG = "uploads/banner.jpg";
let _sidebarCategoriesKey = "";
let _sidebarEventsBound = false;
let isSaving = false;
let adminCategorySavePending = false;
let adminProductSavePending = false;
const ADMIN_SUBMIT_COOLDOWN_MS = 1500;
const SAVE_PRODUCTS_QUEUE_MAX_RETRIES = 8;
const SAVE_PRODUCTS_RETRY_DELAY_MS = 1500;

const _saveProductsQueue = [];
let _saveProductsQueueDraining = false;
let catalogLoadInFlight = null;
let shopTelegramUiReady = false;
let bannerLoadDone = false;
let storeRenderFingerprint = "";
let _cachedCategoriesProducts = null;
let _cachedProducts = null;

const tg = window.Telegram.WebApp;

function parseCourierFastGoUrlParamsEarly() {
  const hash = window.location.hash || "";
  const hashQuery = hash.includes("?") ? hash.split("?")[1] : "";
  const searchQuery = (window.location.search || "").replace(/^\?/, "");
  const combined = [hashQuery, searchQuery].filter(Boolean).join("&");
  return new URLSearchParams(combined);
}

/** Старые WebApp-ссылки ?courier_fast_go=1 → серверная страница «Поехали» (без витрины). */
(function redirectCourierFastGoAwayFromShop() {
  const urlParams = parseCourierFastGoUrlParamsEarly();
  if (urlParams.get("courier_fast_go") !== "1") {
    return;
  }
  const orderId = String(urlParams.get("order_id") || "").trim();
  if (!orderId) {
    return;
  }
  window.COURIER_FAST_GO_ACTIVE = true;
  const target = `/go/${encodeURIComponent(orderId)}`;
  if (
    !window.location.pathname.includes("/go/") &&
    !window.location.pathname.includes("/api/courier/go/")
  ) {
    window.location.replace(target);
  }
})();

window.COURIER_FAST_GO_ACTIVE =
  window.COURIER_FAST_GO_ACTIVE === true ||
  parseCourierFastGoUrlParamsEarly().get("courier_fast_go") === "1";

const OP_ADD_CATEGORY = "add_category";
const OP_ADD_PRODUCT = "add_product";

/** Подтверждается только через POST /api/check_admin. */
let IS_ADMIN = false;

const ADMIN_BTN_LABEL_OFF = "⚙️ Управление магазином";
const ADMIN_BTN_LABEL_ON = "✅ Режим редактирования (Вкл)";

/** null — все категории; иначе id категории для фильтра витрины. */
let ACTIVE_CATEGORY_FILTER = null;

if (!window.CART) {
  window.CART = [];
}

function snapshotCartLines() {
  if (!Array.isArray(window.CART)) return [];
  return window.CART.map((line) => ({ ...line }));
}

function restoreCartLines(snapshot) {
  window.CART = Array.isArray(snapshot)
    ? snapshot.map((line) => ({ ...line }))
    : [];
}

window.activePromoCode = "";
window.activePromoDiscount = 0;

function getTelegramUserId() {
  try {
    const id = tg.initDataUnsafe?.user?.id;
    return id != null ? String(id) : "";
  } catch {
    return "";
  }
}

function getTrackingUrlParams() {
  return new URLSearchParams(window.location.search);
}

/** order_id: аргумент → query ?order_id= (прямая ссылка из чата курьера). */
function getTrackingOrderIdFromUrl(explicitOrderId) {
  if (explicitOrderId != null && String(explicitOrderId).trim()) {
    return String(explicitOrderId).trim();
  }
  return getTrackingUrlParams().get("order_id")?.trim() || "";
}

function getTrackingClientCoordsFromUrl() {
  const params = getTrackingUrlParams();
  const lat = parseFloat(params.get("client_lat"));
  const lon = parseFloat(params.get("client_lon"));
  return {
    lat: Number.isFinite(lat) ? lat : undefined,
    lon: Number.isFinite(lon) ? lon : undefined,
  };
}

function waitForTelegramUserId(maxWaitMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const id = getTelegramUserId();
      if (id || Date.now() - started >= maxWaitMs) {
        resolve(id || "");
        return;
      }
      setTimeout(tick, 80);
    };
    if (typeof tg?.ready === "function") {
      tg.ready(tick);
    } else {
      tick();
    }
  });
}

function getAdminToggleButton() {
  return document.getElementById("toggle-admin-mode-btn");
}

function getAdminToggleContainer() {
  return document.getElementById("admin-panel-toggle-container");
}

function hideAdminPanelToggle() {
  const adminBtn = getAdminToggleButton();
  const container = getAdminToggleContainer();
  if (adminBtn) adminBtn.style.display = "none";
  if (container) container.style.display = "none";
}

function showAdminPanelToggle() {
  const adminBtn = getAdminToggleButton();
  const container = getAdminToggleContainer();
  if (container) container.style.display = "block";
  if (adminBtn) adminBtn.style.display = "block";
}

function hideAdminManagementBlock() {
  const mgmt = document.getElementById("admin-management-block");
  window.ADMIN_MODE_ACTIVE = false;
  if (mgmt) {
    mgmt.style.display = "none";
    mgmt.setAttribute("aria-hidden", "true");
  }
}

function verifyAdminRoleFromServer() {
  hideAdminPanelToggle();
  hideAdminManagementBlock();
  IS_ADMIN = false;

  const tgUser = window.Telegram?.WebApp?.initDataUnsafe?.user;
  window.ADMIN_USER_ID =
    tgUser?.id != null ? String(tgUser.id) : getTelegramUserId();

  if (!tgUser?.id) {
    return Promise.resolve(false);
  }

  return fetch("/api/check_admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: String(tgUser.id) }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data?.is_admin === true) {
        IS_ADMIN = true;
        window.ADMIN_MODE_ACTIVE = false;
        showAdminPanelToggle();
        syncAdminModeUi();
        return true;
      }
      IS_ADMIN = false;
      hideAdminPanelToggle();
      hideAdminManagementBlock();
      return false;
    })
    .catch((err) => {
      console.error("Ошибка проверки роли:", err);
      IS_ADMIN = false;
      hideAdminPanelToggle();
      hideAdminManagementBlock();
      return false;
    });
}

function isAdminEditMode() {
  return IS_ADMIN && window.ADMIN_MODE_ACTIVE === true;
}

function syncProductGridsAdminClass() {
  const singleGrid = document.getElementById("products-grid");
  if (singleGrid) {
    if (window.ADMIN_MODE_ACTIVE === true) {
      singleGrid.classList.add("admin-mode-active");
    } else {
      singleGrid.classList.remove("admin-mode-active");
    }
  }

  document.querySelectorAll(".products-grid, .product-grid").forEach((grid) => {
    if (window.ADMIN_MODE_ACTIVE === true) {
      grid.classList.add("admin-mode-active");
    } else {
      grid.classList.remove("admin-mode-active");
    }
  });
}

function syncAdminModeUi() {
  const btn = document.getElementById("toggle-admin-mode-btn");
  const mgmt = document.getElementById("admin-management-block");
  const tabsNav = document.querySelector(".admin-tabs-nav");

  if (btn) {
    btn.textContent = window.ADMIN_MODE_ACTIVE
      ? ADMIN_BTN_LABEL_ON
      : ADMIN_BTN_LABEL_OFF;
    btn.classList.toggle("admin-mode-on", window.ADMIN_MODE_ACTIVE === true);
  }

  if (mgmt) {
    mgmt.style.display = window.ADMIN_MODE_ACTIVE ? "block" : "none";
    mgmt.setAttribute(
      "aria-hidden",
      window.ADMIN_MODE_ACTIVE ? "false" : "true"
    );
  }

  if (tabsNav) {
    tabsNav.style.display = window.ADMIN_MODE_ACTIVE ? "flex" : "none";
  }

  if (window.ADMIN_MODE_ACTIVE) {
    window.switchAdminTab("tab-stats");
  } else {
    document.querySelectorAll(".admin-tab-content").forEach((content) => {
      content.style.display = "none";
    });
    document.querySelectorAll(".admin-tab-btn").forEach((tabBtn) => {
      tabBtn.classList.remove("active");
    });
  }

  ensureCatalogLayoutVisible();
  syncProductGridsAdminClass();
}

function showAdminTriggerImmediately() {
  try {
    verifyAdminRoleFromServer();
  } catch {
    hideAdminPanelToggle();
    hideAdminManagementBlock();
    IS_ADMIN = false;
  }
}

function normalizePayload(raw) {
  if (!raw || typeof raw !== "object") {
    return { categories: [], products: [] };
  }
  const cats = raw.categories;
  const prods = raw.products;
  return {
    categories: Array.isArray(cats) ? cats.map((c) => ({ ...c })) : [],
    products: Array.isArray(prods)
      ? prods.map((p) => {
          const unitType = normalizeUnitType(p.unit_type);
          const isWeightItem =
            p.is_weight_item === true || (p.is_weight_item !== false && unitType === "weight");
          const stockQty = Math.max(0, Math.floor(Number(p.stock_quantity) || 0));
          const out = {
            ...p,
            unit_type: unitType,
            is_weight_item: isWeightItem,
            stock_quantity: isWeightItem ? 0 : stockQty,
            price_per_unit: unitType === "weight" ? "100g" : "pcs",
            in_stock: isWeightItem
              ? p.in_stock !== false
              : stockQty > 0,
          };
          if (
            unitType === "weight" &&
            String(p.price_per_unit || "").toLowerCase() === "kg"
          ) {
            out.price = Math.round((Number(p.price) || 0) / 10);
          }
          return out;
        })
      : [],
  };
}

function ensureStoreShape() {
  if (!window.STORE_DATA || typeof window.STORE_DATA !== "object") {
    window.STORE_DATA = { categories: [], products: [] };
  }
  if (!Array.isArray(window.STORE_DATA.categories)) {
    window.STORE_DATA.categories = [];
  }
  if (!Array.isArray(window.STORE_DATA.products)) {
    window.STORE_DATA.products = [];
  }
}

function computeStoreRenderFingerprint(store = window.STORE_DATA) {
  const cats = Array.isArray(store?.categories) ? store.categories : [];
  const prods = Array.isArray(store?.products) ? store.products : [];
  const catKey = cats
    .map((c) => `${c?.id}:${c?.title}:${c?.image}`)
    .join("|");
  const prodKey = prods
    .map(
      (p) =>
        `${p?.id}:${p?.category_id}:${p?.name}:${p?.price}:${p?.image}:${p?.in_stock}:${p?.discount}:${p?.is_weight_item}:${p?.stock_quantity}`
    )
    .join("|");
  return `${catKey}__${prodKey}`;
}

function catalogDomHasProductCards() {
  return Boolean(
    document.querySelector("#catalog-container .product-card[data-product-id]")
  );
}

/** Сколько карточек реально попадёт в секции при текущем фильтре категорий. */
function countRenderableCatalogCards(catsToShow, productsAll) {
  if (!Array.isArray(catsToShow) || !catsToShow.length) return 0;
  const prods = Array.isArray(productsAll) ? productsAll : [];
  let n = 0;
  for (const cat of catsToShow) {
    const catId = String(cat.id);
    n += prods.filter((p) => String(p.category_id) === catId).length;
  }
  return n;
}

/** Новый/удалённый товар в STORE_DATA относительно DOM (не рассинхрон фильтра). */
function storeHasStructuralCatalogChangesVsDom(existingCards) {
  const products = window.STORE_DATA?.products || [];
  const storeIds = new Set(products.map((p) => String(p.id)));
  for (const id of storeIds) {
    if (!existingCards.has(id)) return true;
  }
  for (const id of existingCards.keys()) {
    if (!storeIds.has(id)) return true;
  }
  return false;
}

function revealVisibleCatalogImages(root = document.getElementById("catalog-container")) {
  if (!root) return;
  root.querySelectorAll(".product-img").forEach((img) => {
    img.classList.add("is-visible");
    img.style.opacity = "1";
  });
  root.querySelectorAll(".product-card").forEach((card) => {
    card.style.opacity = "1";
  });
}

function readCatalogFromLocalStorage() {
  try {
    const raw = localStorage.getItem(CATALOG_LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return normalizePayload(parsed);
  } catch {
    return null;
  }
}

function persistCatalogToLocalStorage(store) {
  try {
    if (
      !store ||
      !Array.isArray(store.categories) ||
      !Array.isArray(store.products) ||
      isCatalogStoreEmpty(store)
    ) {
      return;
    }
    localStorage.setItem(
      CATALOG_LS_KEY,
      JSON.stringify({
        categories: store.categories,
        products: store.products,
      })
    );
  } catch {
    /* quota / private mode */
  }
}

function isCatalogStoreEmpty(store = window.STORE_DATA) {
  const cats = store?.categories;
  const prods = store?.products;
  return (
    !Array.isArray(cats) ||
    !Array.isArray(prods) ||
    (cats.length === 0 && prods.length === 0)
  );
}

function parseCatalogApiBody(text, httpOk) {
  if (!text || !String(text).trim()) {
    return { ok: false, reason: "empty_body" };
  }
  if (!httpOk) {
    return { ok: false, reason: "http_error" };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const store = normalizePayload(raw);
  if (isCatalogStoreEmpty(store)) {
    return { ok: false, reason: "empty_catalog" };
  }
  return { ok: true, store, raw };
}

/**
 * Применяет каталог с сервера; в фоне или при уже отрисованных карточках
 * не затирает витрину пустым/битым ответом.
 */
function tryApplyStoreDataFromPayload(parsed, options = {}) {
  const store = normalizePayload(parsed);
  const backgroundSync = options.backgroundSync === true;
  const hasCards = catalogDomHasProductCards();

  if (isCatalogStoreEmpty(store)) {
    if (backgroundSync || hasCards) {
      console.warn(
        "[catalog] Пустой или неверный каталог не применён — витрина сохранена"
      );
      return false;
    }
  }

  applyStoreDataFromPayload(store, {
    persist: options.persist !== false && !isCatalogStoreEmpty(store),
  });
  return true;
}

function applyStoreDataFromPayload(parsed, options = {}) {
  window.STORE_DATA = normalizePayload(parsed);
  ensureStoreShape();
  _cachedCategoriesProducts = null;
  _cachedProducts = null;
  window.allProducts = window.STORE_DATA.products;
  window.allCategories = window.STORE_DATA.categories;
  if (options.persist !== false) {
    persistCatalogToLocalStorage(window.STORE_DATA);
  }
}

/** Inline / localStorage — мгновенный первый кадр (если ещё не применён __INITIAL_PRODUCTS__). */
function hydrateStoreFromBootstrap() {
  if (window.__HAS_INITIAL_PRODUCTS__ === true) {
    return true;
  }
  if (window.__INITIAL_PRODUCTS__ && typeof window.__INITIAL_PRODUCTS__ === "object") {
    applyStoreDataFromPayload(window.__INITIAL_PRODUCTS__, { persist: true });
    window.__HAS_INITIAL_PRODUCTS__ = true;
    return true;
  }
  const cached = readCatalogFromLocalStorage();
  if (cached && (cached.categories.length || cached.products.length)) {
    applyStoreDataFromPayload(cached, { persist: false });
    return true;
  }
  return false;
}

function renderStoreFromCurrentData(options = {}) {
  const renderOpts = options.forceSidebar ? { forceSidebar: true } : {};
  storeRenderFingerprint = computeStoreRenderFingerprint();
  if (catalogDomHasProductCards() && options.refresh !== true) {
    refreshCatalogAfterServerSync(renderOpts);
  } else {
    renderStore(renderOpts);
  }
}

function scheduleCatalogImageWarmup() {
  scheduleNonCriticalTask(() => {
    forcePreloadAllImages(
      window.STORE_DATA.products,
      window.STORE_DATA.categories
    );
  });
}

async function loadCatalogFromServer(options = {}) {
  if (catalogLoadInFlight) {
    return catalogLoadInFlight;
  }

  const backgroundSync =
    options.background === true ||
    (options.background !== false && window.__HAS_INITIAL_PRODUCTS__ === true);

  catalogLoadInFlight = (async () => {
    const fingerprintBeforeFetch = computeStoreRenderFingerprint();
    let catalogDataApplied = false;

    try {
      const res = await fetch("/api/products");
      const text = await res.text();
      const parsed = parseCatalogApiBody(text, res.ok);

      if (parsed.ok) {
        catalogDataApplied = tryApplyStoreDataFromPayload(parsed.store, {
          backgroundSync,
          persist: true,
        });
      } else if (!backgroundSync) {
        console.warn("[catalog] /api/products:", parsed.reason);
        if (!catalogDomHasProductCards()) {
          if (!hydrateStoreFromBootstrap()) {
            applyStoreDataFromPayload({ categories: [], products: [] });
            catalogDataApplied = true;
          }
        }
      } else {
        console.warn("[catalog] Фоновый sync пропущен:", parsed.reason);
      }
    } catch (e) {
      console.error(e);
      if (backgroundSync) {
        scheduleCatalogImageWarmup();
        return;
      }
      if (!catalogDomHasProductCards()) {
        if (!hydrateStoreFromBootstrap()) {
          applyStoreDataFromPayload({ categories: [], products: [] });
          catalogDataApplied = true;
        }
      }
    }

    if (!catalogDataApplied && backgroundSync) {
      scheduleCatalogImageWarmup();
      scheduleActiveOrderCheckAfterCatalogLoad();
      return;
    }

    const nextFingerprint = computeStoreRenderFingerprint();
    const forceRender = options.forceRender === true;
    const renderOpts = options.forceSidebar ? { forceSidebar: true } : {};

    const canSkipHeavyRender =
      !forceRender &&
      catalogDomHasProductCards() &&
      (storeRenderFingerprint === nextFingerprint ||
        (backgroundSync && fingerprintBeforeFetch === nextFingerprint));

    if (canSkipHeavyRender) {
      renderAdminCategorySelect();
      if (options.forceSidebar) {
        renderCategorySidebar(true);
      }
      scheduleCatalogImageWarmup();
      scheduleActiveOrderCheckAfterCatalogLoad();
      return;
    }

    storeRenderFingerprint = nextFingerprint;
    runWhenCartUiIdle(() => {
      if (
        isCatalogUserInteractionBlocking() &&
        catalogDomHasProductCards()
      ) {
        scheduleCatalogImageWarmup();
        scheduleActiveOrderCheckAfterCatalogLoad();
        return;
      }
      if (catalogDomHasProductCards()) {
        refreshCatalogAfterServerSync(renderOpts);
      } else {
        renderStore(renderOpts);
      }
      scheduleCatalogImageWarmup();
      scheduleActiveOrderCheckAfterCatalogLoad();
    });
  })();

  try {
    return await catalogLoadInFlight;
  } finally {
    catalogLoadInFlight = null;
  }
}

function delayMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function executeSaveProductsFetch(fetchFn, job) {
  const res = await fetchFn();
  const data = await parseJsonResponse(res);

  if (res.status === 429) {
    if ((job.retryCount || 0) < SAVE_PRODUCTS_QUEUE_MAX_RETRIES) {
      job.retryCount = (job.retryCount || 0) + 1;
      console.warn(
        `save_products: 429, повтор ${job.retryCount}/${SAVE_PRODUCTS_QUEUE_MAX_RETRIES} через ${SAVE_PRODUCTS_RETRY_DELAY_MS}ms`
      );
      await delayMs(SAVE_PRODUCTS_RETRY_DELAY_MS);
      return { retry: true };
    }
    tg.showAlert(
      "Слишком много запросов сохранения. Подождите минуту и нажмите «Сохранить» снова."
    );
    return { ok: false, rateLimited: true, res, data };
  }

  return {
    ok: res.ok && data.ok !== false,
    res,
    data,
  };
}

async function drainSaveProductsQueue() {
  if (_saveProductsQueueDraining) return;
  _saveProductsQueueDraining = true;

  try {
    while (_saveProductsQueue.length > 0) {
      const job = _saveProductsQueue[0];
      isSaving = true;
      let outcome;
      try {
        outcome = await executeSaveProductsFetch(job.fetchFn, job);
      } catch (networkErr) {
        console.error("save_products:", networkErr);
        outcome = {
          ok: false,
          networkError: true,
          error: networkErr,
        };
      } finally {
        isSaving = false;
      }

      if (outcome?.retry) {
        continue;
      }

      _saveProductsQueue.shift();
      job.resolve(outcome);
    }
  } finally {
    _saveProductsQueueDraining = false;
    if (_saveProductsQueue.length > 0) {
      drainSaveProductsQueue();
    }
  }
}

function enqueueSaveProductsRequest(fetchFn) {
  return new Promise((resolve) => {
    _saveProductsQueue.push({
      fetchFn,
      resolve,
      retryCount: 0,
    });
    drainSaveProductsQueue();
  });
}

async function postSaveProductsRequest(fetchFn) {
  return enqueueSaveProductsRequest(fetchFn);
}

function invalidateStoreCatalogCache() {
  _cachedCategoriesProducts = null;
  _cachedProducts = null;
  storeRenderFingerprint = null;
}

function makeOptimisticCategoryId() {
  return `cat_${Date.now()}`;
}

function makeOptimisticProductId() {
  return `prod_${Date.now()}`;
}

function applyOptimisticCategoryEntry({ id, title, image }) {
  ensureStoreShape();
  window.STORE_DATA.categories.push({
    id: String(id),
    title: String(title),
    image: String(image || ""),
    _optimistic: true,
  });
  invalidateStoreCatalogCache();
  return function rollbackOptimisticCategory() {
    window.STORE_DATA.categories = window.STORE_DATA.categories.filter(
      (c) => String(c.id) !== String(id)
    );
    invalidateStoreCatalogCache();
  };
}

function applyOptimisticProductEntry({
  id,
  categoryId,
  name,
  price,
  unitType,
  image,
}) {
  ensureStoreShape();
  const normalized = normalizeUnitType(unitType || "pcs");
  const isWeight = normalized === "weight";
  const product = {
    id: String(id),
    category_id: String(categoryId),
    name: String(name),
    price: Math.round(Number(price) || 0),
    image: String(image || ""),
    unit_type: normalized,
    price_per_unit: isWeight ? "100g" : "pcs",
    is_weight_item: isWeight,
    stock_quantity: 0,
    in_stock: isWeight,
    _optimistic: true,
  };
  window.STORE_DATA.products.push(product);
  window.allProducts = window.STORE_DATA.products;
  invalidateStoreCatalogCache();
  return function rollbackOptimisticProduct() {
    window.STORE_DATA.products = window.STORE_DATA.products.filter(
      (p) => String(p.id) !== String(id)
    );
    window.allProducts = window.STORE_DATA.products;
    invalidateStoreCatalogCache();
  };
}

function renderStorefrontOptimistic() {
  ensureStoreShape();
  window.allProducts = window.STORE_DATA.products;
  window.allCategories = window.STORE_DATA.categories;
  persistCatalogToLocalStorage(window.STORE_DATA);
  renderStore({ forceSidebar: true, forceRender: true });
}

function offerAdminSaveRetry(message) {
  const text = `${message}\n\nНажмите «Сохранить» ещё раз, чтобы повторить отправку.`;
  if (typeof tg?.showAlert === "function") {
    tg.showAlert(text);
  } else {
    alert(text);
  }
}

async function syncStorefrontAfterAdminSave(options = {}) {
  await reloadStorefrontFromServer({
    forceSidebar: true,
    forceRender: options.forceRender !== false,
  });
  if (options.resetCategoryForm) {
    document.getElementById("admin-category-form")?.reset();
  }
  if (options.resetProductForm) {
    const addForm = document.getElementById("admin-product-form");
    addForm?.reset();
    const pcsBtn = addForm?.querySelector('[data-unit-type="pcs"]');
    if (pcsBtn) window.setAdminUnitType("pcs", pcsBtn);
  }
  clearAdminFileInputs();
  tg.HapticFeedback?.impactOccurred?.("light");
}

function setAdminSubmitButtonsLocked(selector, locked, busyLabel) {
  document.querySelectorAll(selector).forEach((btn) => {
    if (locked) {
      if (btn.dataset.adminSubmitLabel == null) {
        btn.dataset.adminSubmitLabel = btn.textContent || "";
      }
      btn.disabled = true;
      btn.classList.add("admin-submit-btn--busy");
      if (busyLabel) btn.textContent = busyLabel;
    } else {
      btn.disabled = false;
      btn.classList.remove("admin-submit-btn--busy");
      if (btn.dataset.adminSubmitLabel != null) {
        btn.textContent = btn.dataset.adminSubmitLabel;
        delete btn.dataset.adminSubmitLabel;
      }
    }
  });
}

function lockAdminSubmitButtonsTemporarily(selector, busyLabel) {
  setAdminSubmitButtonsLocked(selector, true, busyLabel);
  window.setTimeout(() => {
    setAdminSubmitButtonsLocked(selector, false);
  }, ADMIN_SUBMIT_COOLDOWN_MS);
}

async function runAdminCatalogSaveAction({
  getPending,
  setPending,
  buttonSelector,
  busyLabel,
  action,
}) {
  if (getPending()) return;
  setPending(true);
  lockAdminSubmitButtonsTemporarily(buttonSelector, busyLabel);
  try {
    await action();
  } finally {
    setPending(false);
  }
}

function parseJsonResponse(res) {
  return res.json().catch(() => ({}));
}

function categoryIconSrc(cat) {
  if (cat && cat.image && String(cat.image).trim()) return cat.image;
  const t = encodeURIComponent(String(cat?.title || "?").slice(0, 12));
  return `https://placehold.co/100x100?text=${t}`;
}

function sidebarLabel(cat) {
  const t = cat?.title || cat?.id || "";
  return t.length > 22 ? `${t.slice(0, 20)}…` : t;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function normalizeProductDiscount(raw) {
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(99, Math.round(n)));
}

function normalizeUnitType(raw) {
  return String(raw || "pcs").toLowerCase() === "weight" ? "weight" : "pcs";
}

function isWeightProduct(productOrLine) {
  return normalizeUnitType(productOrLine?.unit_type) === "weight";
}

function isWeightItemProduct(product) {
  if (!product) return false;
  if (product.is_weight_item === true) return true;
  if (product.is_weight_item === false) return false;
  return isWeightProduct(product);
}

function getProductStockQuantity(product) {
  const qty = Number(product?.stock_quantity);
  if (!Number.isFinite(qty) || qty < 0) return 0;
  return Math.floor(qty);
}

function getStoreProductById(productId) {
  ensureStoreShape();
  return window.STORE_DATA.products.find(
    (p) => String(p.id) === String(productId)
  );
}

function getCurrentCartQuantity(productId) {
  return getCartLineQuantity(productId);
}

function isPieceProductAtStockLimit(product, currentInCart) {
  if (!product || isWeightItemProduct(product)) return false;
  const maxAvailable = getProductStockQuantity(product);
  return currentInCart >= maxAvailable;
}

function showPieceStockLimitAlert(maxAvailable) {
  const max = Math.max(0, Math.floor(Number(maxAvailable) || 0));
  const msg = `Извините, на складе осталось всего ${max} шт. этого товара.`;
  if (window.Telegram?.WebApp?.showAlert) {
    window.Telegram.WebApp.showAlert(msg);
  } else if (typeof tg?.showAlert === "function") {
    tg.showAlert(msg);
  } else {
    alert(msg);
  }
}

function showOrderSubmitError(message) {
  const msg = String(message || "Не удалось оформить заказ.").trim();
  if (window.Telegram?.WebApp?.showAlert) {
    window.Telegram.WebApp.showAlert(msg);
  } else if (typeof tg?.showAlert === "function") {
    tg.showAlert(msg);
  } else {
    alert(msg);
  }
}

function isPiecePlusButtonDisabled(productId) {
  const product = getStoreProductById(productId);
  if (!product || isWeightItemProduct(product)) return false;
  return isPieceProductAtStockLimit(product, getCurrentCartQuantity(productId));
}

function isProductInStock(product) {
  if (!product) return false;
  if (isWeightItemProduct(product)) {
    return product.in_stock !== false;
  }
  return getProductStockQuantity(product) > 0;
}

function getCartQuantityStep(line) {
  return isWeightProduct(line) ? 100 : 1;
}

function getDefaultCartQuantity(product) {
  return isWeightProduct(product) ? 100 : 1;
}

function normalizeModalWeightGrams(grams) {
  const g = Math.round(Number(grams) || 0);
  return Math.max(100, Math.round(g / 100) * 100);
}

function formatWeightLabel(grams) {
  const g = Math.round(Number(grams) || 0);
  if (g >= 1000) {
    if (g % 1000 === 0) return `Вес: ${g / 1000} кг`;
    const kg = Math.round((g / 1000) * 10) / 10;
    return `Вес: ${kg} кг`;
  }
  return `Вес: ${g} г`;
}

function formatWeightDisplayText(grams) {
  const g = Math.round(Number(grams) || 0);
  if (g >= 1000) {
    const kgText = (g / 1000).toFixed(1).replace(/\.0$/, "");
    return `${kgText} кг`;
  }
  return `${g} г`;
}

window.currentWeightProduct = null;
window.currentSelectedWeight = 100;
window._weightModalTriggerBtn = null;

window.openWeightModal = function (product, triggerBtn) {
  if (!product) return;

  window._weightModalTriggerBtn = triggerBtn || null;
  window.currentWeightProduct = product;
  window.currentSelectedWeight = 100;

  const titleEl = document.getElementById("weight-modal-title");
  const priceInfoEl = document.getElementById("weight-modal-price-info");
  const modal = document.getElementById("weight-modal");

  if (titleEl) titleEl.innerText = String(product.name ?? "Выбор веса");
  if (priceInfoEl) {
    priceInfoEl.innerText = `Цена: ${product.price} грн за 100г`;
  }
  if (modal) modal.style.display = "flex";

  window.updateWeightModalUI();
};

window.closeWeightModal = function () {
  const modal = document.getElementById("weight-modal");
  if (modal) modal.style.display = "none";

  const btn = window._weightModalTriggerBtn;
  if (btn) {
    btn.disabled = false;
    delete btn.dataset.addToCartBusy;
  }
  window._weightModalTriggerBtn = null;
  window.currentWeightProduct = null;
};

window.changeModalWeight = function (amount) {
  const step = Number(amount) || 0;
  window.currentSelectedWeight = normalizeModalWeightGrams(
    (Number(window.currentSelectedWeight) || 100) + step
  );
  window.updateWeightModalUI();
};

window.updateWeightModalUI = function () {
  const product = window.currentWeightProduct;
  if (!product) return;

  const grams = normalizeModalWeightGrams(window.currentSelectedWeight);
  window.currentSelectedWeight = grams;

  const valueEl = document.getElementById("weight-modal-value");
  if (valueEl) {
    valueEl.innerText = formatWeightDisplayText(grams);
  }

  const discount = normalizeProductDiscount(product.discount);
  const pricePer100g =
    discount > 0
      ? Math.round(Number(product.price) * (1 - discount / 100))
      : Math.round(Number(product.price) || 0);

  const totalPrice = Math.round((pricePer100g / 100) * grams);
  const totalEl = document.getElementById("weight-modal-total-price");
  if (totalEl) {
    totalEl.innerText = `${totalPrice} грн`;
  }

  const confirmBtn = document.getElementById("weight-modal-confirm-btn");
  if (confirmBtn) {
    confirmBtn.onclick = () => {
      window.addWeightProductToCart(product.id, window.currentSelectedWeight);
      document.getElementById("weight-modal").style.display = "none";
      window.currentWeightProduct = null;

      const btn = window._weightModalTriggerBtn;
      if (btn) {
        btn.textContent = "✓";
        btn.classList.add("btn-add-plus--done");
        window.setTimeout(() => {
          btn.textContent = "+";
          btn.classList.remove("btn-add-plus--done");
          btn.disabled = false;
          delete btn.dataset.addToCartBusy;
        }, 600);
      }
      window._weightModalTriggerBtn = null;

      tg.HapticFeedback?.impactOccurred?.("light");
    };
  }
};

window.addWeightProductToCart = function addWeightProductToCart(productId, weight) {
  const id = String(productId ?? "").trim();
  if (!id) return;

  ensureStoreShape();
  const product = window.STORE_DATA.products.find((p) => String(p.id) === id);
  if (!product) return;

  const grams = normalizeModalWeightGrams(weight);
  const pricePer100g = getDiscountedUnitPriceRounded(product);

  if (!Array.isArray(window.CART)) {
    window.CART = [];
  }

  const existing = window.CART.find((line) => String(line.id) === id);

  if (existing) {
    existing.quantity = (Number(existing.quantity) || 0) + grams;
    existing.price = pricePer100g;
    existing.unit_type = "weight";
    existing.price_per_unit = "100g";
    existing.count = existing.quantity;
  } else {
    window.CART.push({
      id: product.id,
      name: String(product.name ?? ""),
      price: pricePer100g,
      base_price: Number(product.price) || 0,
      discount: normalizeProductDiscount(product.discount),
      unit_type: "weight",
      price_per_unit: "100g",
      quantity: grams,
      count: grams,
    });
  }

  notifyCartLineChanged(product.id);
};

function resolveAdminUnitTypeRoot(triggerEl) {
  if (!triggerEl) {
    return (
      document.getElementById("admin-product-form") ||
      document.getElementById("admin-edit-product-modal")
    );
  }
  if (typeof triggerEl.closest === "function") {
    const fromBtn = triggerEl.closest(
      "#admin-product-form, #admin-edit-product-modal"
    );
    if (fromBtn) return fromBtn;
  }
  if (
    triggerEl.id === "admin-product-form" ||
    triggerEl.id === "admin-edit-product-modal"
  ) {
    return triggerEl;
  }
  return document.getElementById("admin-product-form");
}

window.setAdminUnitType = function (type, element) {
  const normalized = normalizeUnitType(type);
  window.currentAdminUnitType = normalized;

  const parent = element?.parentElement;
  if (parent) {
    const buttons = parent.querySelectorAll("button");
    buttons.forEach((btn) => {
      btn.classList.remove("active");
      btn.classList.remove("is-active");
      btn.style.opacity = "0.6";
    });
  }

  if (element) {
    element.classList.add("active");
    element.classList.add("is-active");
    element.style.opacity = "1";
  }

  const root = resolveAdminUnitTypeRoot(element);
  if (root) {
    const select = root.querySelector(
      "#admin-unit-type, #edit-admin-unit-type, select[name='unit_type']"
    );
    if (select) select.value = normalized;

    const priceLabel = root.querySelector(
      "#admin-price-label, #edit-admin-price-label"
    );
    if (priceLabel) {
      priceLabel.textContent =
        normalized === "weight" ? "Цена (₴ за 100 г)" : "Цена (₴ за шт.)";
    }
  }
};

function initAdminUnitTypeToggle() {
  if (window._adminUnitTypeToggleInit) return;
  window._adminUnitTypeToggleInit = true;

  const addForm = document.getElementById("admin-product-form");
  const pcsBtn = addForm?.querySelector('[data-unit-type="pcs"]');
  if (pcsBtn) {
    window.setAdminUnitType("pcs", pcsBtn);
  }

  document.getElementById("admin-edit-product-modal")?.addEventListener("click", (e) => {
    if (e.target?.id === "admin-edit-product-modal") {
      window.closeEditProductModal();
    }
  });
}

window.openEditProductModal = function (productId) {
  ensureStoreShape();
  const product = window.STORE_DATA.products.find(
    (p) => String(p.id) === String(productId)
  );
  if (!product) return;

  const modal = document.getElementById("admin-edit-product-modal");
  const idEl = document.getElementById("edit-product-id");
  const nameEl = document.getElementById("edit-product-name");
  const priceEl = document.getElementById("edit-admin-price");

  if (idEl) idEl.value = String(product.id);
  if (nameEl) nameEl.value = String(product.name ?? "");
  if (priceEl) priceEl.value = String(Number(product.price) || 0);

  if (modal) {
    const unitType = normalizeUnitType(product.unit_type || "pcs");
    const activeBtn = modal.querySelector(
      `.admin-unit-type-btn[data-unit-type="${unitType}"]`
    );
    if (activeBtn) {
      window.setAdminUnitType(unitType, activeBtn);
    } else {
      window.currentAdminUnitType = unitType;
    }
    modal.style.display = "flex";
  }
};

window.closeEditProductModal = function () {
  const modal = document.getElementById("admin-edit-product-modal");
  if (modal) modal.style.display = "none";
};

window.saveEditProductModal = function () {
  const productId = document.getElementById("edit-product-id")?.value?.trim();
  const newName = document.getElementById("edit-product-name")?.value?.trim();
  const newPriceRaw = document.getElementById("edit-admin-price")?.value;
  const unitType = normalizeUnitType(window.currentAdminUnitType || "pcs");

  if (!productId || !newName) {
    tg.showAlert("Укажите название товара.");
    return;
  }

  const newPrice = parseFloat(newPriceRaw);
  if (Number.isNaN(newPrice) || newPrice < 0) {
    tg.showAlert("Укажите корректную цену.");
    return;
  }

  fetch("/api/admin/edit_product", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: tg.initDataUnsafe?.user?.id || window.ADMIN_USER_ID,
      id: productId,
      name: newName,
      price: newPrice,
      unit_type: unitType,
    }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.success) {
        window.closeEditProductModal();
        tg.showAlert("Товар обновлён!");
        reloadStorefrontFromServer({ forceRender: true });
      } else {
        tg.showAlert("Ошибка сохранения");
      }
    })
    .catch(() => tg.showAlert("Ошибка сети"));
};

function initWeightModalUi() {
  document.getElementById("weight-modal")?.addEventListener("click", (e) => {
    if (e.target?.id === "weight-modal") {
      window.closeWeightModal();
    }
  });
}

function formatCartQuantityMeta(item) {
  const q = Number(item.quantity ?? item.count) || 0;
  if (isWeightProduct(item)) {
    return formatWeightDisplayText(q);
  }
  return `${q} шт`;
}

function getCartLineTotal(line) {
  const qty = Number(line.quantity ?? line.count) || 0;
  const price = Number(line.price) || 0;
  if (isWeightProduct(line)) {
    return (price / 100) * qty;
  }
  return price * qty;
}

function getProductEffectivePrice(product) {
  const base = Number(product?.price) || 0;
  const discount = normalizeProductDiscount(product?.discount);
  if (discount > 0) return base * (1 - discount / 100);
  return base;
}

function formatPriceUi(amount) {
  const rounded = Math.round(Number(amount) * 100) / 100;
  if (Number.isNaN(rounded)) return "0";
  if (Math.abs(rounded - Math.round(rounded)) < 1e-9) {
    return String(Math.round(rounded));
  }
  return String(rounded.toFixed(2)).replace(/\.?0+$/, "");
}

function getProductPriceUnitLabel(unitType) {
  return normalizeUnitType(unitType) === "weight" ? "грн/100г" : "грн/шт";
}

function formatProductCardPriceHtml(amount, unitType) {
  const value = Math.round(Number(amount) || 0);
  const unitLabel = getProductPriceUnitLabel(unitType);
  return `<span class="price-value">${escapeHtml(String(value))}</span> <span class="product-price-unit unit-text">${escapeHtml(unitLabel)}</span>`;
}

function getCartSubtotal() {
  let sum = 0;
  for (const line of window.CART || []) {
    sum += getCartLineTotal(line);
  }
  return sum;
}

function getCartPromoDiscountAmount() {
  let productsTotal = getCartSubtotal();
  const promo = Number(window.activePromoDiscount) || 0;
  if (promo <= 0) return 0;
  return productsTotal * (promo / 100);
}

function getCartTotalWithPromo() {
  let productsTotal = getCartSubtotal();
  const promo = Number(window.activePromoDiscount) || 0;
  if (promo > 0) {
    const promoDiscountAmount = productsTotal * (promo / 100);
    productsTotal = productsTotal - promoDiscountAmount;
  }
  return productsTotal;
}

function getDiscountedUnitPriceRounded(product) {
  const base = Number(product?.price) || 0;
  const discount = normalizeProductDiscount(product?.discount);
  if (discount > 0) {
    return Math.round(base * (1 - discount / 100));
  }
  return Math.round(base);
}

function resolveProductImageUrl(imagePath) {
  const raw = String(imagePath || "").trim();
  if (!raw) return "";
  if (
    raw.startsWith("http://") ||
    raw.startsWith("https://") ||
    raw.startsWith("blob:") ||
    raw.startsWith("data:")
  ) {
    return raw;
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function getCachedImageUrl(url) {
  if (window.imageCache.has(url) && window.imageCache.get(url) !== "loading") {
    return url;
  }
  return url;
}

function productImageUrl(imagePath) {
  const url = window.originalProductImageUrl
    ? window.originalProductImageUrl(imagePath)
    : resolveProductImageUrl(imagePath);
  return getCachedImageUrl(url);
}

async function forcePreloadAllImages(products, categories) {
  const allImages = [];

  if (categories && Array.isArray(categories)) {
    categories.forEach((c) => {
      if (c.image && String(c.image).trim()) {
        allImages.push(productImageUrl(c.image));
      }
    });
  }

  if (products && Array.isArray(products)) {
    products.forEach((p) => {
      if (p.image && String(p.image).trim()) {
        allImages.push(productImageUrl(p.image));
      }
    });
  }

  if (window.imageCache && window.imageCache.size > 200) {
    const staleImageCache = window.imageCache;
    window.imageCache = new Map();
    scheduleNonCriticalTask(() => staleImageCache.clear());
  } else if (!window.imageCache) {
    window.imageCache = new Map();
  }

  const loadPromises = allImages.map((url) => {
    if (window.imageCache.has(url) && window.imageCache.get(url) !== "loading") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        window.imageCache.set(url, url);
        resolve();
      };
      img.onerror = () => {
        window.imageCache.delete(url);
        resolve();
      };
      img.src = url;
      window.imageCache.set(url, "loading");
    });
  });

  await Promise.all(loadPromises);
  scheduleNonCriticalTask(() => {
    console.log(
      `✅ [CACHE] Успешно предзагружено ${allImages.length} изображений в оперативную память.`
    );
  });
}

if (typeof resolveProductImageUrl === "function" && !window.originalProductImageUrl) {
  window.originalProductImageUrl = resolveProductImageUrl;
  window.productImageUrl = function (imagePath) {
    const url = window.originalProductImageUrl(imagePath);
    return getCachedImageUrl(url);
  };
}

const CATALOG_USER_INTERACTION_MS = 3500;

function markCatalogUserInteraction() {
  window._catalogUserInteractionUntil = Date.now() + CATALOG_USER_INTERACTION_MS;
}

function isCatalogUserInteractionBlocking() {
  return Date.now() < (window._catalogUserInteractionUntil || 0);
}

/** null = все категории; только пустая строка считается ошибкой. */
function normalizeActiveCategoryFilterValue() {
  if (ACTIVE_CATEGORY_FILTER === "" || ACTIVE_CATEGORY_FILTER === "null") {
    ACTIVE_CATEGORY_FILTER = null;
  }
}

function invalidateCategoryProductsCache() {
  _cachedCategoriesProducts = null;
  _cachedProducts = null;
}

/** Согласует фильтр с тем, что уже на экране (до layout-check / перерендера). */
function syncActiveCategoryFilterFromCatalogDom() {
  const container = document.getElementById("catalog-container");
  if (!container) return;

  const sections = container.querySelectorAll(
    ".catalog-section[data-category-id]"
  );
  if (!sections.length) return;

  if (sections.length === 1) {
    const only = sections[0];
    if (only.querySelector(".product-card[data-product-id]")) {
      const id = only.getAttribute("data-category-id");
      if (id != null && String(id) !== "") {
        if (String(ACTIVE_CATEGORY_FILTER) !== String(id)) {
          ACTIVE_CATEGORY_FILTER = id;
          invalidateCategoryProductsCache();
        }
      }
    }
    return;
  }

  if (ACTIVE_CATEGORY_FILTER != null) {
    ACTIVE_CATEGORY_FILTER = null;
    invalidateCategoryProductsCache();
  }
}

function ensureActiveCategoryFilterGuard() {
  normalizeActiveCategoryFilterValue();
}

function getCategoriesToShow(cats) {
  normalizeActiveCategoryFilterValue();

  if (ACTIVE_CATEGORY_FILTER == null) {
    return cats;
  }
  return cats.filter((c) => String(c.id) === String(ACTIVE_CATEGORY_FILTER));
}

function getProductsForCategories(catsToShow, productsAll) {
  const prods = Array.isArray(productsAll) ? productsAll : [];
  const catIds = new Set(catsToShow.map((c) => String(c.id)));
  return prods.filter((p) => catIds.has(String(p.category_id)));
}

function getProductsForCategoriesCached(catsToShow, productsAll) {
  if (!catsToShow || !productsAll) return [];
  const cacheKey = catsToShow.map((c) => c.id).join("|");
  if (_cachedCategoriesProducts === cacheKey && _cachedProducts) {
    return _cachedProducts;
  }
  _cachedCategoriesProducts = cacheKey;
  _cachedProducts = getProductsForCategories(catsToShow, productsAll);
  return _cachedProducts;
}

function renderAdminCategorySelect() {
  const cats = window.STORE_DATA.categories;
  const select = document.getElementById("admin-category");
  if (!select) return;

  if (!cats.length) {
    select.innerHTML = '<option value="">— Нет категорий —</option>';
    return;
  }

  select.innerHTML = cats
    .map(
      (c) =>
        `<option value="${escapeAttr(String(c.id))}">${escapeHtml(String(c.title || c.id))}</option>`
    )
    .join("");
}

function updateCategoryNavActiveState() {
  const sidebar = document.getElementById("categories-sidebar");
  if (!sidebar) return;

  sidebar.querySelectorAll(".category-nav-btn").forEach((btn) => {
    const id = btn.getAttribute("data-category-id");
    const isActive =
      ACTIVE_CATEGORY_FILTER != null &&
      String(ACTIVE_CATEGORY_FILTER) === String(id);
    btn.classList.toggle("is-active", isActive);
  });
}

function bindCategorySidebarEvents() {
  const sidebar = document.getElementById("categories-sidebar");
  if (!sidebar || _sidebarEventsBound) return;

  sidebar.addEventListener("click", (ev) => {
    const delBtn = ev.target.closest(
      '.category-delete-btn[data-delete-kind="category"]'
    );
    if (delBtn) {
      ev.stopPropagation();
      const idx = Number(delBtn.getAttribute("data-index"));
      deleteItem("category", idx);
      return;
    }

    const btn = ev.target.closest(".category-nav-btn");
    if (!btn) return;

    const id = btn.getAttribute("data-category-id");
    if (!id) return;

    if (
      ACTIVE_CATEGORY_FILTER != null &&
      String(ACTIVE_CATEGORY_FILTER) === String(id)
    ) {
      ACTIVE_CATEGORY_FILTER = null;
    } else {
      ACTIVE_CATEGORY_FILTER = id;
    }

    invalidateCategoryProductsCache();
    updateCategoryNavActiveState();
    renderProductCatalog({ force: true });
  });

  _sidebarEventsBound = true;
}

function renderCategorySidebar(forceRebuild = false) {
  const cats = window.STORE_DATA.categories;
  const sidebar = document.getElementById("categories-sidebar");
  if (!sidebar) return;

  const categoriesKey = cats.map((c) => String(c.id)).join("|");
  const needRebuild =
    forceRebuild ||
    categoriesKey !== _sidebarCategoriesKey ||
    !sidebar.querySelector(".sidebar-nav");

  if (!cats.length) {
    sidebar.innerHTML = "";
    _sidebarCategoriesKey = "";
    return;
  }

  if (needRebuild) {
    _sidebarCategoriesKey = categoriesKey;
    const navHtml = cats
      .map((cat, catIndex) => {
        const img = categoryIconSrc(cat);
        const label = sidebarLabel(cat);
        const isActive =
          ACTIVE_CATEGORY_FILTER != null &&
          String(ACTIVE_CATEGORY_FILTER) === String(cat.id);
        const del = isAdminEditMode()
          ? `<button type="button" class="category-delete-btn admin-visible" data-delete-kind="category" data-index="${catIndex}" aria-label="Удалить категорию">❌</button>`
          : "";
        return `
        <div class="category-nav-item">
          ${del}
          <button type="button" class="category-nav-btn${isActive ? " is-active" : ""}" data-category-id="${escapeAttr(String(cat.id))}" aria-label="${escapeAttr(label)}">
            <span class="category-nav-icon"><img class="category-img" src="${escapeAttr(img)}" alt="" loading="eager" fetchpriority="high" decoding="async" /></span>
            <span class="category-nav-label">${escapeHtml(label)}</span>
          </button>
        </div>`;
      })
      .join("");

    sidebar.innerHTML = `<nav class="sidebar-nav">${navHtml}</nav>`;
    bindCategorySidebarEvents();
  } else {
    updateCategoryNavActiveState();
  }
}

let catalogClickDelegationBound = false;

function getProductBasePriceFromCard(card) {
  const productId = card.getAttribute("data-product-id");
  const product = (window.STORE_DATA?.products || []).find(
    (item) => String(item?.id) === String(productId)
  );
  if (product) return Math.round(Number(product.price) || 0);
  const priceEl = card.querySelector(
    ".product-price-wrap > .product-price .price-value, .product-price-wrap > .price-value"
  );
  if (!priceEl) return 0;
  const parsed = parseFloat(String(priceEl.textContent).replace(",", "."));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function handleCatalogGridClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const card = target.closest(".product-card[data-product-id]");
  if (!card) return;

  const productId = card.getAttribute("data-product-id");
  if (!productId) return;

  if (target.closest(".btn-edit-price-pencil, .btn-admin-price")) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.editProductPrice === "function") {
      window.editProductPrice(productId, getProductBasePriceFromCard(card));
    }
    return;
  }

  if (
    isAdminEditMode() &&
    target.closest(".product-price-wrap .price-value")
  ) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.editProductPrice === "function") {
      window.editProductPrice(productId, getProductBasePriceFromCard(card));
    }
    return;
  }

  if (target.closest(".btn-edit-pencil")) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.openEditProductModal === "function") {
      window.openEditProductModal(productId);
    }
    return;
  }

  if (target.closest(".btn-admin-delete")) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.deleteProduct === "function") {
      window.deleteProduct(productId);
    }
    return;
  }

  if (target.closest(".btn-admin-stock")) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.toggleStock === "function") {
      window.toggleStock(productId);
    }
    return;
  }

  if (target.closest(".btn-admin-stock-save")) {
    event.preventDefault();
    event.stopPropagation();
    const row = target.closest(".admin-stock-qty-row");
    const input = row?.querySelector(".admin-stock-qty-input");
    if (input && typeof window.setProductStockQuantity === "function") {
      window.setProductStockQuantity(productId, input.value);
    }
    return;
  }

  if (target.closest(".btn-admin-discount")) {
    event.preventDefault();
    event.stopPropagation();
    const discountBtn = target.closest(".btn-admin-discount");
    const discount = Number(discountBtn?.dataset.discount) || 0;
    if (typeof window.setProductDiscountPrompt === "function") {
      window.setProductDiscountPrompt(productId, discount);
    }
    return;
  }

  if (target.closest(".product-card-actions, .btn-add-plus, .add-to-cart-btn")) {
    event.preventDefault();
    event.stopPropagation();

    if (target.closest(".btn-add-plus")) {
      window.addToCart?.(productId, event);
      return;
    }

    if (target.closest(".product-card-actions .btn-minus")) {
      window.changeQuantity?.(productId, -1, event);
      return;
    }

    if (target.closest(".product-card-actions .btn-plus")) {
      window.changeQuantity?.(productId, 1, event);
    }
    return;
  }
}

function handleCatalogStockQtyChange(event) {
  const input = event.target?.closest?.(".admin-stock-qty-input");
  if (!input) return;
  const card = input.closest(".product-card[data-product-id]");
  const productId = card?.getAttribute("data-product-id");
  if (!productId || typeof window.setProductStockQuantity !== "function") return;
  window.setProductStockQuantity(productId, input.value);
}

function setupCatalogClickDelegation() {
  if (catalogClickDelegationBound) return;
  const container =
    document.getElementById("catalog-container") ||
    document.getElementById("products-grid");
  if (!container) return;
  container.addEventListener("click", handleCatalogGridClick);
  container.addEventListener("change", handleCatalogStockQtyChange);
  catalogClickDelegationBound = true;
}

function catalogLayoutNeedsFullRender() {
  const container = document.getElementById("catalog-container");
  if (!container) return true;

  if (catalogDomHasProductCards()) {
    syncActiveCategoryFilterFromCatalogDom();
  }

  const cats = window.STORE_DATA?.categories || [];
  if (!cats.length) {
    return Boolean(
      container.querySelector(".product-card, .catalog-section")
    );
  }

  const catsToShow = getCategoriesToShow(cats);
  const sections = container.querySelectorAll(".catalog-section[data-category-id]");
  if (sections.length !== catsToShow.length) return true;

  for (const cat of catsToShow) {
    const id = String(cat.id);
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(id)
        : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const section = container.querySelector(
      `.catalog-section[data-category-id="${escaped}"]`
    );
    if (!section) return true;

    const titleEl = section.querySelector(".catalog-section-title");
    const expectedTitle = String(cat.title || cat.id);
    if (titleEl && titleEl.textContent !== expectedTitle) return true;
  }

  return false;
}

function refreshCatalogAfterServerSync(options = {}) {
  const savedFilter = ACTIVE_CATEGORY_FILTER;
  const scrollEl = document.getElementById("catalog-content");
  const savedScrollTop = scrollEl?.scrollTop ?? 0;

  ensureStoreShape();
  ensureCatalogLayoutVisible();
  renderAdminCategorySelect();

  const cats = window.STORE_DATA.categories || [];
  const categoriesKey = cats.map((c) => String(c.id)).join("|");
  const sidebar = document.getElementById("categories-sidebar");
  const needSidebarRebuild =
    options.forceSidebar === true ||
    categoriesKey !== _sidebarCategoriesKey ||
    !sidebar?.querySelector(".sidebar-nav");

  if (needSidebarRebuild) {
    renderCategorySidebar(options.forceSidebar === true);
  } else {
    updateCategoryNavActiveState();
  }

  ACTIVE_CATEGORY_FILTER = savedFilter;
  normalizeActiveCategoryFilterValue();

  if (
    isCatalogUserInteractionBlocking() &&
    catalogDomHasProductCards() &&
    options.forceRender !== true
  ) {
    updateCategoryNavActiveState();
    return;
  }

  if (catalogDomHasProductCards()) {
    syncActiveCategoryFilterFromCatalogDom();
  }

  const existingCards = new Map();
  document.querySelectorAll(".product-card[data-product-id]").forEach((card) => {
    existingCards.set(String(card.getAttribute("data-product-id")), card);
  });

  const catsToShow = getCategoriesToShow(cats);
  let currentProducts = getProductsForCategoriesCached(
    catsToShow,
    window.STORE_DATA?.products || []
  );

  if (existingCards.size > 0 && currentProducts.length === 0) {
    syncActiveCategoryFilterFromCatalogDom();
    const retryCats = getCategoriesToShow(cats);
    currentProducts = getProductsForCategoriesCached(
      retryCats,
      window.STORE_DATA?.products || []
    );
    if (currentProducts.length === 0) {
      console.warn(
        "[RENDER] 0 товаров для текущего фильтра — витрина на экране не трогаем"
      );
      updateCategoryNavActiveState();
      return;
    }
  }

  const structuralChange =
    options.forceRender === true ||
    existingCards.size === 0 ||
    storeHasStructuralCatalogChangesVsDom(existingCards);

  let hasNewOrRemoved = structuralChange;

  if (
    !hasNewOrRemoved &&
    catalogLayoutNeedsFullRender() &&
    existingCards.size === 0
  ) {
    hasNewOrRemoved = true;
  }

  if (hasNewOrRemoved) {
    if (isCatalogStoreEmpty() && catalogDomHasProductCards()) {
      console.warn(
        "[RENDER] Пустой STORE_DATA — полный перерендер витрины пропущен"
      );
    } else if (
      catalogDomHasProductCards() &&
      countRenderableCatalogCards(
        catsToShow,
        window.STORE_DATA?.products || []
      ) === 0
    ) {
      console.warn(
        "[RENDER] Полный перерендер дал бы пустую витрину — пропуск"
      );
    } else {
      console.log(
        "[RENDER] Состав товаров изменился, вызываем полный перерендер."
      );
      renderProductCatalog();
    }
  } else {
    console.log(
      "[RENDER] Точечное обновление данных без пересоздания DOM."
    );
    currentProducts.forEach((product) => {
      const existingCard = existingCards.get(String(product.id));
      if (existingCard) {
        updateProductCard(product, existingCard);
      }
    });
    revealVisibleCatalogImages();
  }

  updateCategoryNavActiveState();
  syncProductGridsAdminClass();

  if (scrollEl && options.restoreScroll !== false) {
    scrollEl.scrollTop = savedScrollTop;
  }
}

function scheduleActiveOrderCheckAfterCatalogLoad() {
  if (
    TRACKING_MODE ||
    COURIER_DELIVERY_MODE ||
    COURIER_FAST_START_MODE ||
    window.COURIER_FAST_GO_ACTIVE
  ) {
    return;
  }
  scheduleNonCriticalTask(() => {
    checkActiveUserOrder();
  });
}

/** Откладывает полный рендер витрины, пока обновляется UI корзины (счётчики). */
function runWhenCartUiIdle(fn, attempt = 0) {
  if (window._cartUiUpdateInProgress) {
    if (attempt < 50) {
      window.setTimeout(() => runWhenCartUiIdle(fn, attempt + 1), 20);
    } else {
      fn();
    }
    return;
  }
  fn();
}

function renderProductCatalog(options = {}) {
  if ((window._storefrontRenderLock || 0) > 0) {
    return;
  }

  if (
    options.force !== true &&
    isCatalogUserInteractionBlocking() &&
    catalogDomHasProductCards()
  ) {
    return;
  }

  const cartSnapshot = snapshotCartLines();
  const savedFilter = window.ACTIVE_CATEGORY_FILTER || ACTIVE_CATEGORY_FILTER;
  const preserveExistingCards = catalogDomHasProductCards();

  try {
    scheduleNonCriticalTask(() => {
      console.log("Рендер каталога вызван! Текущий фильтр:", ACTIVE_CATEGORY_FILTER);
    });

    const cats = window.STORE_DATA.categories;
    const productsAll = window.STORE_DATA.products;
    const container = document.getElementById("catalog-container");
    if (!container) return;

    normalizeActiveCategoryFilterValue();

    if (!cats.length) {
      if (preserveExistingCards) {
        console.warn(
          "[catalog] Нет категорий в STORE_DATA — сохраняем текущие карточки на экране"
        );
        return;
      }
      container.innerHTML =
        '<p class="catalog-empty">Категории пока не настроены.</p>';
      return;
    }

    let catsToShow = getCategoriesToShow(cats);
    if (!catsToShow.length && cats.length) {
      ACTIVE_CATEGORY_FILTER = null;
      catsToShow = getCategoriesToShow(cats);
    }
    if (!catsToShow.length) {
      if (preserveExistingCards) {
        console.warn(
          "[catalog] Фильтр категории не совпал — сохраняем текущие карточки"
        );
        return;
      }
      container.innerHTML =
        '<p class="catalog-empty">Категория не найдена.</p>';
      return;
    }

    const filteredProducts = getProductsForCategoriesCached(
      catsToShow,
      productsAll
    );

    const renderableCardCount = countRenderableCatalogCards(
      catsToShow,
      productsAll
    );
    if (!renderableCardCount && preserveExistingCards) {
      console.warn(
        "[catalog] 0 карточек для фильтра/категорий — сохраняем DOM на экране"
      );
      syncActiveCategoryFilterFromCatalogDom();
      return;
    }

    let catalogProductIndex = 0;
    const sectionsHtml = catsToShow
      .map((cat) => {
        const catId = cat.id;
        const title = cat.title || catId;

        const rows = filteredProducts.filter(
          (p) => String(p.category_id) === String(catId)
        );

        const cardsHtml = rows
          .map((p) => {
            const cardHtml = renderProductCard(p, catalogProductIndex);
            catalogProductIndex += 1;
            return cardHtml;
          })
          .join("");

        if (!cardsHtml) {
          return `
        <section class="catalog-section" data-category-id="${escapeAttr(String(catId))}">
          <h2 class="catalog-section-title">${escapeHtml(String(title))}</h2>
          <p class="catalog-empty">Нет товаров.</p>
        </section>`;
        }

        return `
        <section class="catalog-section" data-category-id="${escapeAttr(String(catId))}">
          <h2 class="catalog-section-title">${escapeHtml(String(title))}</h2>
          <div class="product-grid products-grid">${cardsHtml}</div>
        </section>`;
      })
      .join("");

    container.innerHTML = sectionsHtml;
    syncProductGridsAdminClass();
    revealVisibleCatalogImages(container);
  } finally {
    restoreCartLines(cartSnapshot);
    refreshAllProductCardCounters();
    revealVisibleCatalogImages();

    if (
      savedFilter !== undefined &&
      (window.ACTIVE_CATEGORY_FILTER !== savedFilter ||
        ACTIVE_CATEGORY_FILTER !== savedFilter)
    ) {
      if (window.ACTIVE_CATEGORY_FILTER !== undefined) {
        window.ACTIVE_CATEGORY_FILTER = savedFilter;
      } else {
        ACTIVE_CATEGORY_FILTER = savedFilter;
      }

      if (typeof updateCategoryNavActiveState === "function") {
        updateCategoryNavActiveState();
      }
    }
  }
}

function renderStore(options = {}) {
  if ((window._storefrontRenderLock || 0) > 0) {
    return;
  }

  const forceSidebar = options.forceSidebar === true;

  ensureStoreShape();
  ensureCatalogLayoutVisible();

  const catsRaw = window.STORE_DATA.categories;
  const productsRaw = window.STORE_DATA.products;

  if (!Array.isArray(catsRaw)) {
    window.STORE_DATA.categories = [];
    renderStore(options);
    return;
  }
  if (!Array.isArray(productsRaw)) {
    window.STORE_DATA.products = [];
  }

  const sidebar = document.getElementById("categories-sidebar");
  const container = document.getElementById("catalog-container");
  if (!sidebar || !container) return;

  renderAdminCategorySelect();
  renderCategorySidebar(forceSidebar);
  renderProductCatalog();
}

function renderProductCard(product, catalogIndex = 0) {
  const p = product;
  const isFirstRows = catalogIndex < 6;
  const loadingStrategy = isFirstRows ? "eager" : "lazy";
  const fetchPriority = isFirstRows ? "high" : "low";
  const isWeightItem = isWeightItemProduct(p);
  const outOfStock = !isProductInStock(p);
  const inStock = !outOfStock;
  const editMode = isAdminEditMode();
  const imgSrc = p.image ? String(p.image).trim() : "";
  const imgUrl = productImageUrl(imgSrc);
  const fallbackImg = escapeAttr(DEFAULT_PRODUCT_IMG);
  const nameEsc = escapeAttr(String(p.name ?? ""));
  const priceVal = Number(p.price) || 0;
  const productDiscount = normalizeProductDiscount(p.discount);
  const basePriceRounded = Math.round(priceVal);
  const salePriceRounded = getDiscountedUnitPriceRounded(p);
  const unitType = normalizeUnitType(p.unit_type);
  const discountBadge =
    productDiscount > 0
      ? `<span class="discount-badge">-${productDiscount}%</span>`
      : "";
  const priceHtml =
    productDiscount > 0
      ? `<span class="old-price">${formatProductCardPriceHtml(basePriceRounded, unitType)}</span> <span class="product-price product-price--sale">${formatProductCardPriceHtml(salePriceRounded, unitType)}</span>`
      : `<p class="product-price">${formatProductCardPriceHtml(basePriceRounded, unitType)}</p>`;
  const quickEditBtn =
    window.ADMIN_MODE_ACTIVE === true
      ? `<button type="button" class="btn-edit-pencil" aria-label="Редактировать товар">✏️</button>`
      : "";
  const cardClass =
    !inStock && !editMode ? "product-card out-of-stock" : "product-card";

  const soldBadge =
    !inStock && !editMode
      ? '<span class="product-stock-badge">Нет в наличии</span>'
      : "";

  const cartQty = getCartLineQuantity(p.id);
  const cartQtyLabel = formatProductCardCountDisplay(p, cartQty);
  const hasCartQty = cartQty > 0;
  const plusAtStockLimit =
    !isWeightItemProduct(p) && isPieceProductAtStockLimit(p, cartQty);
  const plusBtnDisabled = plusAtStockLimit ? " disabled" : "";
  const addBtn = inStock
    ? `<div class="product-card-actions">
        <button type="button" class="btn-add-plus"${hasCartQty ? " hidden" : ""} aria-label="Добавить в корзину">+</button>
        <div class="product-cart-qty"${hasCartQty ? "" : " hidden"} role="group" aria-label="Количество в корзине">
          <button type="button" class="btn-minus order-qty-btn" aria-label="Меньше">−</button>
          <span id="${escapeAttr(productCountElementId(p.id))}" class="product-count-value order-qty-value">${escapeHtml(cartQtyLabel)}</span>
          <button type="button" class="btn-plus order-qty-btn${plusAtStockLimit ? " order-qty-btn--disabled" : ""}"${plusBtnDisabled} aria-label="Больше"${plusAtStockLimit ? ' aria-disabled="true"' : ""}>+</button>
        </div>
      </div>`
    : `<button type="button" class="add-to-cart-btn add-to-cart-btn--disabled" disabled aria-label="Нет в наличии">Нет в наличии</button>`;

  const stockBtnLabel = inStock
    ? "🟢 В наличии"
    : editMode
      ? "Выставить в продажу"
      : "🔴 Нет в наличии";

  const adminControls = editMode
    ? `<div class="product-card-admin-actions">
        <div class="admin-card-controls">
          ${isWeightItem
            ? `<button type="button" class="btn-admin-stock">${stockBtnLabel}</button>`
            : `<div class="admin-stock-qty-row">
          <label class="admin-stock-qty-label">На складе (шт)
            <input
              type="number"
              class="admin-stock-qty-input"
              min="0"
              step="1"
              inputmode="numeric"
              value="${getProductStockQuantity(p)}"
              aria-label="Количество на складе"
            />
          </label>
          <button type="button" class="btn-admin-stock-save">Сохранить</button>
        </div>`}
          <button type="button" class="btn-admin-discount" data-discount="${productDiscount}">🏷️ Скидка</button>
          <button type="button" class="btn-admin-price">💰 Цена</button>
          <button type="button" class="btn-admin-delete">🗑️ Удалить</button>
        </div>
      </div>`
    : "";

  const imgBlock = imgUrl
    ? `<div class="product-img-wrapper">
        ${discountBadge}
        <img class="product-img" src="${escapeAttr(imgUrl)}" loading="${loadingStrategy}" fetchpriority="${fetchPriority}" decoding="async" width="400" height="400" alt="${nameEsc}" onload="this.classList.add('is-visible')" onerror="this.src='${fallbackImg}'">
      </div>`
    : `<div class="product-img-wrapper product-img-wrapper--empty" aria-hidden="true">${discountBadge}</div>`;

  const nameBlock = `<div class="product-card-name">
        <div class="product-name-row">
          <h3 class="product-name">${escapeHtml(String(p.name ?? ""))}</h3>
          ${quickEditBtn}
        </div>
      </div>`;

  const priceEditBtn = editMode
    ? `<button type="button" class="btn-edit-price-pencil" aria-label="Изменить цену">✏️</button>`
    : "";
  const priceBlock = `<div class="product-card-price"><div class="product-price-wrap">${priceHtml}${priceEditBtn}</div></div>`;

  const clientActionsBlock = `<div class="product-card-client-actions">${addBtn}</div>`;

  return `
    <article class="${cardClass}" data-product-id="${escapeAttr(String(p.id))}">
      ${soldBadge}
      ${imgBlock}
      ${nameBlock}
      <div class="product-card-footer product-card-footer--price">
        ${priceBlock}
        ${clientActionsBlock}
      </div>
      ${adminControls}
    </article>`;
}

function updateProductCard(product, cardElement) {
  if (!cardElement || !product) return;

  const wrap = cardElement.querySelector(".product-price-wrap");
  if (wrap) {
    const unitType = normalizeUnitType(product.unit_type);
    const basePriceRounded = Math.round(Number(product.price) || 0);
    const productDiscount = normalizeProductDiscount(product.discount);
    const salePriceRounded = getDiscountedUnitPriceRounded(product);
    const hasSaleStructure = Boolean(wrap.querySelector(".product-price--sale"));
    const needsSale = productDiscount > 0;

    if (hasSaleStructure !== needsSale) {
      const priceEditBtn = wrap.querySelector(".btn-edit-price-pencil");
      const priceHtml = needsSale
        ? `<span class="old-price">${formatProductCardPriceHtml(basePriceRounded, unitType)}</span> <span class="product-price product-price--sale">${formatProductCardPriceHtml(salePriceRounded, unitType)}</span>`
        : `<p class="product-price">${formatProductCardPriceHtml(basePriceRounded, unitType)}</p>`;
      wrap.innerHTML = priceHtml;
      if (priceEditBtn) {
        wrap.appendChild(priceEditBtn);
      } else if (isAdminEditMode()) {
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "btn-edit-price-pencil";
        editBtn.setAttribute("aria-label", "Изменить цену");
        editBtn.textContent = "✏️";
        wrap.appendChild(editBtn);
      }
    } else {
      const priceEl = wrap.querySelector(
        ".product-price--sale .price-value, .product-price .price-value, .price-value"
      );
      const newPrice =
        typeof getDiscountedUnitPriceRounded === "function"
          ? getDiscountedUnitPriceRounded(product)
          : product.price_discount || product.price;
      const newPriceStr = String(Math.round(Number(newPrice) || 0));

      if (priceEl && priceEl.textContent.trim() !== newPriceStr) {
        priceEl.textContent = newPriceStr;
      }

      if (needsSale) {
        const oldPriceEl = wrap.querySelector(".old-price .price-value");
        const baseStr = String(basePriceRounded);
        if (oldPriceEl && oldPriceEl.textContent.trim() !== baseStr) {
          oldPriceEl.textContent = baseStr;
        }
      }
    }
  }

  const inStock = isProductInStock(product);
  const editMode = isAdminEditMode();
  const isWeightItem = isWeightItemProduct(product);
  const stockBtn = cardElement.querySelector(".btn-admin-stock");
  if (stockBtn && isWeightItem) {
    const stockText = inStock
      ? "🟢 В наличии"
      : editMode
        ? "Выставить в продажу"
        : "🔴 Нет в наличии";
    if (stockBtn.textContent !== stockText) {
      stockBtn.textContent = stockText;
    }
  }

  const stockInput = cardElement.querySelector(".admin-stock-qty-input");
  if (stockInput && !isWeightItem) {
    const qty = String(getProductStockQuantity(product));
    if (stockInput.value !== qty) {
      stockInput.value = qty;
    }
  }

  const titleEl = cardElement.querySelector(".product-title, .product-name");
  const name = String(product.name ?? "");
  if (titleEl && titleEl.textContent !== name) {
    titleEl.textContent = name;
  }

  const outOfStock = !inStock;
  cardElement.classList.toggle("out-of-stock", outOfStock && !editMode);

  const discountBtn = cardElement.querySelector(".btn-admin-discount");
  if (discountBtn) {
    discountBtn.dataset.discount = String(normalizeProductDiscount(product.discount));
  }
}

window.updateProductCard = updateProductCard;

window.setProductDiscountPrompt = function (pid, currentDiscount) {
  if (!IS_ADMIN) return;

  const raw = prompt(
    "Введите скидку на товар в % (от 0 до 99):",
    String(normalizeProductDiscount(currentDiscount))
  );
  if (raw === null) return;

  const discount = normalizeProductDiscount(raw);
  const userId = tg.initDataUnsafe?.user?.id || window.ADMIN_USER_ID;
  if (!userId) {
    alert("Не удалось определить ID администратора");
    return;
  }

  fetch("/api/admin/set_discount", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      id: pid,
      discount,
    }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.success) {
        alert("Скидка обновлена!");
        reloadStorefrontFromServer({ forceRender: true });
      } else {
        alert(res.error || "Ошибка сохранения скидки");
      }
    })
    .catch(() => alert("Ошибка сохранения скидки"));
};

function patchProductPriceOnCard(productId, newPrice) {
  const pid = String(productId ?? "");
  const product = (window.STORE_DATA?.products || []).find(
    (item) => String(item?.id) === pid
  );
  if (!product) return;

  product.price = newPrice;

  const card = findProductCardElement(pid);
  if (!card) return;

  updateProductCard(product, card);
}

window.editProductPrice = function (productId, currentPrice) {
  if (!IS_ADMIN) return;

  const newPriceText = prompt(
    `Введите новую цену для товара (Текущая цена: ${currentPrice}):`,
    String(currentPrice)
  );
  if (newPriceText === null) return;

  const newPrice = parseFloat(String(newPriceText).replace(",", "."));
  if (Number.isNaN(newPrice) || newPrice <= 0) {
    alert("Пожалуйста, введите корректную цену больше нуля.");
    return;
  }

  const userId = getTelegramUserId();
  if (!userId) {
    alert("Не удалось определить ID администратора");
    return;
  }

  fetch("/api/admin/update_price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      product_id: productId,
      new_price: newPrice,
    }),
  })
    .then((response) => response.json())
    .then((data) => {
      if (data.ok) {
        alert(data.message || "Цена успешно обновлена!");
        reloadStorefrontFromServer({ forceRender: true });
      } else {
        alert("Ошибка при обновлении цены: " + (data.error || "Неизвестная ошибка"));
      }
    })
    .catch((err) => {
      console.error(err);
      alert("Произошла сетевая ошибка");
    });
};

window.renderProducts = function (options = {}) {
  return loadCatalogFromServer({
    forceRender: true,
    forceSidebar: options.forceSidebar === true,
  });
};

async function deleteItem(kind, index) {
  if (!IS_ADMIN) return;
  ensureStoreShape();
  if (kind === "category") await deleteCategory(index);
}

async function deleteCategory(index) {
  ensureStoreShape();
  const cats = window.STORE_DATA.categories;
  if (!Number.isInteger(index) || index < 0 || index >= cats.length) return;

  const removedId = cats[index]?.id;
  cats.splice(index, 1);
  window.STORE_DATA.products = (window.STORE_DATA.products || []).filter(
    (p) => String(p.category_id) !== String(removedId)
  );
  if (
    ACTIVE_CATEGORY_FILTER != null &&
    String(ACTIVE_CATEGORY_FILTER) === String(removedId)
  ) {
    ACTIVE_CATEGORY_FILTER = null;
  }
  await saveProductsToServer();
}

window.setProductStockQuantity = async function (productId, rawQty) {
  if (!IS_ADMIN) return;

  const product = window.STORE_DATA?.products?.find(
    (p) => String(p.id) === String(productId)
  );
  if (product && isWeightItemProduct(product)) {
    tg.showAlert("Для весового товара используйте переключатель наличия.");
    return;
  }

  const stockQuantity = Math.max(0, Math.floor(Number(rawQty) || 0));
  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram.");
    return;
  }

  try {
    const res = await fetch("/api/admin/set_stock_quantity", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        user_id: userId,
        id: productId,
        stock_quantity: stockQuantity,
      }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      tg.showAlert(data.error || "Не удалось обновить остаток.");
      await reloadStorefrontFromServer();
      return;
    }

    const card = findProductCardElement(productId);
    if (product && card) {
      product.stock_quantity = stockQuantity;
      product.is_weight_item = false;
      product.in_stock = stockQuantity > 0;
      updateProductCard(product, card);
    } else {
      await reloadStorefrontFromServer();
    }
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети.");
    await reloadStorefrontFromServer();
  }
};

window.toggleStock = async function (productId) {
  if (!IS_ADMIN) return;

  const product = window.STORE_DATA?.products?.find(
    (p) => String(p.id) === String(productId)
  );
  if (product && !isWeightItemProduct(product)) {
    tg.showAlert("Для штучного товара укажите количество на складе.");
    return;
  }

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram.");
    return;
  }

  try {
    const res = await fetch("/api/admin/toggle_stock", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ user_id: userId, id: productId }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      tg.showAlert(data.error || "Не удалось изменить наличие.");
      await reloadStorefrontFromServer();
      return;
    }

    await reloadStorefrontFromServer();
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети.");
    await reloadStorefrontFromServer();
  }
};

window.deleteProduct = async function (productId) {
  if (!IS_ADMIN) return;
  if (!confirm("Удалить этот товар?")) return;

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram для удаления.");
    return;
  }

  try {
    const res = await fetch("/api/admin/delete_product", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ user_id: userId, id: productId }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      tg.showAlert(data.error || "Не удалось удалить товар.");
      await reloadStorefrontFromServer();
      return;
    }

    await reloadStorefrontFromServer();
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети при удалении.");
    await reloadStorefrontFromServer();
  }
};

function formatMoney(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

function cartQuantityWord(n) {
  const abs = Math.abs(n) % 100;
  const rem = abs % 10;
  if (abs > 10 && abs < 20) return "товаров";
  if (rem === 1) return "товар";
  if (rem >= 2 && rem <= 4) return "товара";
  return "товаров";
}

/**
 * Добавление штучного/весового товара в корзину.
 * Не меняет ACTIVE_CATEGORY_FILTER и не перерисовывает витрину.
 */
window.addToCart = function addToCart(productId, event) {
  stopCartClickEvent(event);

  const btn =
    event != null && event.currentTarget instanceof Element
      ? event.currentTarget
      : event?.target?.closest?.(".btn-add-plus, .add-to-cart-btn");

  if (btn?.dataset?.addToCartBusy === "1") {
    return;
  }

  const id = String(productId ?? "").trim();
  if (!id) return;

  ensureStoreShape();
  const product = window.STORE_DATA.products.find((p) => String(p.id) === id);
  if (!product) return;

  if (!isProductInStock(product)) {
    tg.showAlert("Товар временно отсутствует в наличии.");
    return;
  }

  const price = getDiscountedUnitPriceRounded(product);
  if (Number.isNaN(price) || price < 0) return;

  if (isWeightItemProduct(product)) {
    if (btn) {
      btn.dataset.addToCartBusy = "1";
      btn.disabled = true;
    }
    window.openWeightModal(product, btn);
    return;
  }

  if (!Array.isArray(window.CART)) {
    window.CART = [];
  }

  const existing = window.CART.find((line) => String(line.id) === id);
  const nextQty = (Number(existing?.quantity) || 0) + 1;
  if (!isWeightItemProduct(product)) {
    const maxAvailable = getProductStockQuantity(product);
    if (nextQty > maxAvailable) {
      showPieceStockLimitAlert(maxAvailable);
      return;
    }
  }
  if (existing) {
    existing.quantity = nextQty;
  } else {
    window.CART.push({
      id: product.id,
      name: String(product.name ?? ""),
      price,
      base_price: Number(product.price) || 0,
      discount: normalizeProductDiscount(product.discount),
      unit_type: "pcs",
      price_per_unit: "pcs",
      quantity: 1,
    });
  }

  if (btn) {
    btn.dataset.addToCartBusy = "1";
    btn.disabled = true;
    btn.textContent = "✓";
    btn.classList.add("btn-add-plus--done");
    window.setTimeout(() => {
      btn.textContent = "+";
      btn.classList.remove("btn-add-plus--done");
      btn.disabled = false;
      delete btn.dataset.addToCartBusy;
    }, 600);
  }

  tg.HapticFeedback?.impactOccurred?.("light");
  notifyCartLineChanged(product.id);
};

function patchCartBarSummary() {
  const panel = document.getElementById("cart-checkout-panel");
  const bar = document.getElementById("cart-bar");
  const countEl = document.getElementById("cart-count");
  const totalEl = document.getElementById("cart-total");
  const promoLineEl = document.getElementById("cart-promo-discount-line");
  if (!bar || !countEl || !totalEl) return;

  const cart = Array.isArray(window.CART) ? window.CART : [];
  const lineCount = cart.length;
  const promoDiscountAmount = getCartPromoDiscountAmount();
  const sum = getCartTotalWithPromo();

  if (lineCount === 0) {
    if (panel) panel.classList.remove("cart-checkout-panel--visible");
    bar.classList.remove("cart-bar--visible");
    countEl.textContent = "В корзине: 0 товаров";
    totalEl.textContent = "0 ₴";
    if (promoLineEl) {
      promoLineEl.style.display = "none";
      promoLineEl.textContent = "";
    }
    updateActiveOrderFloatingButton();
    return;
  }

  if (panel) panel.classList.add("cart-checkout-panel--visible");
  bar.classList.add("cart-bar--visible");
  updateActiveOrderFloatingButton();
  countEl.textContent = `В корзине: ${lineCount} ${cartQuantityWord(lineCount)}`;
  totalEl.textContent = `${formatMoney(sum)} ₴`;

  if (promoLineEl) {
    if (promoDiscountAmount > 0) {
      promoLineEl.style.display = "block";
      promoLineEl.textContent = `Скидка по промокоду: -${formatMoney(promoDiscountAmount)} грн`;
    } else {
      promoLineEl.style.display = "none";
      promoLineEl.textContent = "";
    }
  }
}

window.updateCartUI = function () {
  patchCartBarSummary();
};

window.updateCartDisplay = window.updateCartUI;

function syncDeliveryAddressField() {
  const sel = document.getElementById("delivery-method");
  const wrap = document.getElementById("address-field-wrap");
  if (!sel || !wrap) return;
  const isCourier = sel.value === "courier";
  wrap.classList.toggle("is-hidden", !isCourier);
  if (!isCourier) {
    hideAddressSuggestions();
    clearSelectedAddressCoords();
  }
}

const DNIPRO_ADDRESS_VIEWBOX = "34.80,48.60,35.30,48.35";
let addressSuggestTimer = null;
let addressSuggestAbort = null;

window.SELECTED_LAT = null;
window.SELECTED_LON = null;
window.SELECTED_CLIENT_LAT = null;
window.SELECTED_CLIENT_LON = null;

function clearSelectedAddressCoords() {
  window.SELECTED_LAT = null;
  window.SELECTED_LON = null;
  window.SELECTED_CLIENT_LAT = null;
  window.SELECTED_CLIENT_LON = null;
  clearCheckoutClientCoordsStorage();
}

let googleMapsScriptLoadPromise = null;

function isValidGoogleMapsApiKey(key) {
  const normalized = String(key ?? "").trim();
  if (!normalized) return false;
  if (
    normalized === "YOUR_KEY_HERE" ||
    normalized === "__GOOGLE_MAPS_API_KEY__"
  ) {
    return false;
  }
  return true;
}

async function resolveGoogleMapsApiKey() {
  const fromRuntime = window.__RUNTIME_CONFIG__?.googleMapsApiKey;
  if (isValidGoogleMapsApiKey(fromRuntime)) {
    return String(fromRuntime).trim();
  }
  try {
    const res = await fetch("/api/config/public", { cache: "no-store" });
    if (!res.ok) return "";
    const data = await res.json();
    const key = data?.googleMapsApiKey;
    return isValidGoogleMapsApiKey(key) ? String(key).trim() : "";
  } catch (err) {
    console.warn("[maps] /api/config/public:", err);
    return "";
  }
}

/** Загружает Maps/Places JS; ключ только с сервера (GOOGLE_MAPS_API_KEY). */
function loadGoogleMapsFromConfig() {
  if (window.google?.maps?.places?.Autocomplete) {
    return Promise.resolve(true);
  }
  if (!googleMapsScriptLoadPromise) {
    googleMapsScriptLoadPromise = (async () => {
      const apiKey = await resolveGoogleMapsApiKey();
      if (!apiKey) {
        console.warn(
          "[maps] GOOGLE_MAPS_API_KEY не задан — Google Places отключён"
        );
        return false;
      }
      if (document.querySelector("script[data-google-maps-loader]")) {
        return Boolean(window.google?.maps?.places);
      }
      return new Promise((resolve) => {
        const script = document.createElement("script");
        script.dataset.googleMapsLoader = "1";
        script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
          apiKey
        )}&libraries=places&language=uk&region=UA`;
        script.async = true;
        script.defer = true;
        script.onload = () =>
          resolve(Boolean(window.google?.maps?.places?.Autocomplete));
        script.onerror = () => {
          console.warn("[maps] не удалось загрузить Google Maps API");
          resolve(false);
        };
        document.head.appendChild(script);
      });
    })();
  }
  return googleMapsScriptLoadPromise;
}

window.loadGoogleMapsFromConfig = loadGoogleMapsFromConfig;

function isGooglePlacesReady() {
  return Boolean(window.google?.maps?.places?.Autocomplete);
}

const PAC_DROPDOWN_BG = "#1c222b";
const PAC_DROPDOWN_BORDER = "#3a3a3c";
const PAC_DROPDOWN_HOVER = "#2c2c2e";

/** Принудительные стили подсказок Google Places (перебивает inline от Google в WebView). */
function forceApplyPacContainerStyles() {
  document.querySelectorAll(".pac-container").forEach((container) => {
    container.style.setProperty("background-color", PAC_DROPDOWN_BG, "important");
    container.style.setProperty("background", PAC_DROPDOWN_BG, "important");
    container.style.setProperty("border", `1px solid ${PAC_DROPDOWN_BORDER}`, "important");
    container.style.setProperty("border-radius", "12px", "important");
    container.style.setProperty("z-index", "999999", "important");
    container.style.setProperty(
      "box-shadow",
      "0 4px 20px rgba(0, 0, 0, 0.5)",
      "important"
    );
    container.style.setProperty("color", "#ffffff", "important");
    container.style.setProperty("display", "block", "important");
    container.style.setProperty("font-family", "inherit", "important");
  });

  document.querySelectorAll(".pac-item").forEach((item) => {
    item.style.setProperty("background-color", PAC_DROPDOWN_BG, "important");
    item.style.setProperty("background", PAC_DROPDOWN_BG, "important");
    item.style.setProperty("color", "#ffffff", "important");
    item.style.setProperty(
      "border-bottom",
      `1px solid ${PAC_DROPDOWN_BORDER}`,
      "important"
    );
    item.style.setProperty("border-top", "none", "important");
    item.style.setProperty("cursor", "pointer", "important");
  });

  document.querySelectorAll(
    ".pac-item:hover, .pac-item-selected, .pac-item.pac-item-selected"
  ).forEach((item) => {
    item.style.setProperty("background-color", PAC_DROPDOWN_HOVER, "important");
    item.style.setProperty("background", PAC_DROPDOWN_HOVER, "important");
    item.style.setProperty("color", "#ffffff", "important");
  });

  document.querySelectorAll(".pac-item-query").forEach((query) => {
    query.style.setProperty("color", "#ffffff", "important");
    query.style.setProperty("font-weight", "600", "important");
  });

  document.querySelectorAll(".pac-matched").forEach((matched) => {
    matched.style.setProperty("color", "#ff9800", "important");
    matched.style.setProperty("font-weight", "bold", "important");
  });

  document.querySelectorAll(".pac-item span").forEach((span) => {
    if (span.classList.contains("pac-item-query")) return;
    if (span.classList.contains("pac-matched")) return;
    span.style.setProperty("color", "#8e8e93", "important");
  });

  document.querySelectorAll(".pac-icon, .pac-logo").forEach((el) => {
    el.style.setProperty("display", "none", "important");
  });
}

function applyPacSuggestionsWebViewStyles() {
  forceApplyPacContainerStyles();
}

let _pacStyleRepaintTimer = null;

function scheduleForceApplyPacStyles(delayMs = 100) {
  window.clearTimeout(_pacStyleRepaintTimer);
  _pacStyleRepaintTimer = window.setTimeout(() => {
    _pacStyleRepaintTimer = null;
    forceApplyPacContainerStyles();
  }, delayMs);
}

function bindPacWebViewStyleHack(input) {
  if (!input || input.dataset.pacStyleHackBound === "1") return;
  input.dataset.pacStyleHackBound = "1";

  input.addEventListener("input", () => scheduleForceApplyPacStyles(100));
  input.addEventListener("focus", () => scheduleForceApplyPacStyles(100));
}

function persistCheckoutAddressSelection(address, lat, lng) {
  const formatted = String(address || "").trim();
  window.SELECTED_LAT = Number(lat);
  window.SELECTED_LON = Number(lng);
  window.SELECTED_CLIENT_LAT = window.SELECTED_LAT;
  window.SELECTED_CLIENT_LON = window.SELECTED_LON;
  try {
    if (formatted) {
      localStorage.setItem(CHECKOUT_LS.address, formatted);
    }
    localStorage.setItem(CHECKOUT_LS.lat, String(lat));
    localStorage.setItem(CHECKOUT_LS.lon, String(lng));
  } catch (e) {
    console.warn("persistCheckoutAddressSelection:", e);
  }
}

function restoreCheckoutAddressCoordsFromStorage() {
  try {
    const lat = parseFloat(localStorage.getItem(CHECKOUT_LS.lat));
    const lon = parseFloat(localStorage.getItem(CHECKOUT_LS.lon));
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      window.SELECTED_LAT = lat;
      window.SELECTED_LON = lon;
    }
  } catch (e) {
    console.warn("restoreCheckoutAddressCoordsFromStorage:", e);
  }
}

function getCheckoutClientCoordsForSubmit() {
  let lat = parseFloat(localStorage.getItem("checkout_client_lat"));
  let lon = parseFloat(localStorage.getItem("checkout_client_lng"));
  if (!Number.isFinite(lat)) {
    lat = parseFloat(localStorage.getItem(CHECKOUT_LS.lat));
  }
  if (!Number.isFinite(lon)) {
    lon = parseFloat(localStorage.getItem(CHECKOUT_LS.lon));
  }
  if (!Number.isFinite(lat) && window.SELECTED_LAT != null) {
    lat = Number(window.SELECTED_LAT);
  }
  if (!Number.isFinite(lon) && window.SELECTED_LON != null) {
    lon = Number(window.SELECTED_LON);
  }
  return {
    client_lat: Number.isFinite(lat) ? lat : null,
    client_lon: Number.isFinite(lon) ? lon : null,
  };
}

function clearCheckoutClientCoordsStorage() {
  try {
    localStorage.removeItem("checkout_client_lat");
    localStorage.removeItem("checkout_client_lng");
    localStorage.removeItem(CHECKOUT_LS.lat);
    localStorage.removeItem(CHECKOUT_LS.lon);
  } catch (e) {
    console.warn("clearCheckoutClientCoordsStorage:", e);
  }
}

function hideAddressSuggestions() {
  const container = document.getElementById("address-suggestions");
  if (!container) return;
  container.style.display = "none";
  container.innerHTML = "";
}

function fetchDniproAddressSuggestions(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    query + ", Днепр"
  )}&viewbox=${DNIPRO_ADDRESS_VIEWBOX}&bounded=1&addressdetails=1&limit=5`;

  if (addressSuggestAbort) {
    addressSuggestAbort.abort();
  }
  addressSuggestAbort = new AbortController();

  return fetch(url, {
    headers: { "User-Agent": "HalalShopDniproBot/1.0" },
    signal: addressSuggestAbort.signal,
  }).then((res) => res.json());
}

function renderAddressSuggestions(data) {
  const container = document.getElementById("address-suggestions");
  if (!container) return;

  container.innerHTML = "";

  if (data && data.length > 0) {
    container.style.display = "block";
    data.forEach((item) => {
      const display_name = item.display_name
        .split(",")
        .slice(0, 3)
        .join(",")
        .trim();

      const div = document.createElement("div");
      div.textContent = display_name;
      div.style.padding = "10px";
      div.style.cursor = "pointer";
      div.style.borderBottom = "1px solid #eee";
      div.style.fontSize = "14px";

      div.onclick = function () {
        const input = getCheckoutAddressInput();
        if (input) input.value = display_name;
        container.style.display = "none";

        window.SELECTED_LAT = parseFloat(item.lat);
        window.SELECTED_LON = parseFloat(item.lon);
        console.log(
          "Выбран точный адрес:",
          display_name,
          window.SELECTED_LAT,
          window.SELECTED_LON
        );
      };

      container.appendChild(div);
    });
  } else {
    container.style.display = "none";
  }
}

function onClientAddressInput() {
  const input = getCheckoutAddressInput();
  if (!input) return;

  clearSelectedAddressCoords();

  const query = input.value.trim();
  if (query.length < 4) {
    hideAddressSuggestions();
    return;
  }

  window.clearTimeout(addressSuggestTimer);
  addressSuggestTimer = window.setTimeout(() => {
    fetchDniproAddressSuggestions(query)
      .then((data) => renderAddressSuggestions(data))
      .catch((err) => {
        if (err && err.name === "AbortError") return;
        console.error(err);
        hideAddressSuggestions();
      });
  }, 350);
}

function initNominatimAddressAutocomplete(input) {
  if (!input || input.dataset.nominatimBound === "1") return;

  input.addEventListener("input", onClientAddressInput);
  input.dataset.nominatimBound = "1";

  if (!window._addressSuggestClickBound) {
    window._addressSuggestClickBound = true;
    document.addEventListener("click", (e) => {
      const wrap = document.getElementById("address-field-wrap");
      if (wrap && !wrap.contains(e.target)) {
        hideAddressSuggestions();
      }
    });
  }
}

function initGooglePlacesAutocomplete(input) {
  if (!input || !isGooglePlacesReady()) return false;
  if (input.dataset.googlePlacesBound === "1") return true;

  hideAddressSuggestions();

  const options = {
    componentRestrictions: { country: "ua" },
    fields: ["address_components", "geometry", "formatted_address", "name"],
    types: ["address"],
  };

  const autocomplete = new google.maps.places.Autocomplete(input, options);
  // Заставляем Google рендерить подсказки строго под инпутом (без ломания вёрстки в WebView)
  autocomplete.setOptions({ strictBounds: false });
  autocomplete.setBounds(DNIPRO_PLACES_BOUNDS);

  const forceApplyStyles = () => scheduleForceApplyPacStyles(100);

  const startPacStyleObserver = () => {
    if (input._pacStyleObserver) return;
    const observer = new MutationObserver((mutations) => {
      let needsRepaint = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (
            node.classList?.contains("pac-container") ||
            node.querySelector?.(".pac-container, .pac-item")
          ) {
            needsRepaint = true;
            break;
          }
        }
        if (needsRepaint) break;
      }
      if (!needsRepaint && !document.querySelector(".pac-container")) return;

      document.querySelectorAll(".pac-container").forEach((container) => {
        const bg = container.style.backgroundColor || "";
        if (
          !bg ||
          bg === "white" ||
          bg === "#fff" ||
          bg === "#ffffff" ||
          bg === "rgb(255, 255, 255)"
        ) {
          needsRepaint = true;
        }
      });

      if (needsRepaint || document.querySelector(".pac-container")) {
        scheduleForceApplyPacStyles(50);
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    input._pacStyleObserver = observer;
  };

  autocomplete.addListener("place_changed", function () {
    const place = autocomplete.getPlace();
    if (!place.geometry || !place.geometry.location) {
      console.error("Подходящая геометрия не найдена для адреса");
      return;
    }

    let streetName = "";
    let streetNumber = "";

    if (place.address_components) {
      for (let i = 0; i < place.address_components.length; i++) {
        const component = place.address_components[i];
        const types = component.types;

        if (types.includes("route")) {
          streetName = component.long_name;
        }
        if (types.includes("street_number")) {
          streetNumber = component.long_name;
        }
      }
    }

    let fullAddress = "";
    if (streetName) {
      fullAddress = streetName + (streetNumber ? " " + streetNumber : "");
    } else {
      fullAddress = place.name || place.formatted_address || "";
    }

    const addressInput = getCheckoutAddressInput();
    if (addressInput) {
      addressInput.value = fullAddress;
      addressInput.dispatchEvent(new Event("input", { bubbles: true }));
      addressInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const lat = place.geometry.location.lat();
    const lng = place.geometry.location.lng();
    window.SELECTED_CLIENT_LAT = lat;
    window.SELECTED_CLIENT_LON = lng;
    persistCheckoutAddressSelection(fullAddress, lat, lng);
    hideAddressSuggestions();
    forceApplyStyles();

    console.log(
      "✅ Точный адрес зафиксирован:",
      fullAddress,
      "Координаты:",
      window.SELECTED_CLIENT_LAT,
      window.SELECTED_CLIENT_LON
    );
  });

  bindPacWebViewStyleHack(input);

  input.addEventListener("focus", () => {
    forceApplyStyles();
    startPacStyleObserver();
  });
  input.addEventListener("input", () => {
    forceApplyStyles();
    if (!input.value.trim()) {
      clearSelectedAddressCoords();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (input._pacStyleObserver) {
        input._pacStyleObserver.disconnect();
        input._pacStyleObserver = null;
      }
    }, 500);
  });

  startPacStyleObserver();
  forceApplyStyles();

  input.dataset.googlePlacesBound = "1";
  window._googlePlacesAutocomplete = autocomplete;
  return true;
}

function waitForGooglePlacesAutocomplete(input) {
  if (!input || input.dataset.placesWaitStarted === "1") return;
  input.dataset.placesWaitStarted = "1";

  let attempts = 0;
  const maxAttempts = 80;
  const timer = window.setInterval(() => {
    attempts += 1;
    if (initGooglePlacesAutocomplete(input)) {
      window.clearInterval(timer);
      return;
    }
    if (attempts >= maxAttempts) {
      window.clearInterval(timer);
      console.warn(
        "Google Places API недоступен — используется резервный поиск адресов."
      );
      initNominatimAddressAutocomplete(input);
    }
  }, 100);
}

function initAddressAutocomplete() {
  const addressInput = getCheckoutAddressInput();
  if (!addressInput) return;

  bindPacWebViewStyleHack(addressInput);

  loadGoogleMapsFromConfig().then((mapsReady) => {
    if (!mapsReady) {
      initNominatimAddressAutocomplete(addressInput);
      return;
    }
    if (initGooglePlacesAutocomplete(addressInput)) {
      return;
    }
    waitForGooglePlacesAutocomplete(addressInput);
  });
}

function orderModalIsOpen() {
  return Boolean(
    document.getElementById("order-screen")?.classList.contains("order-screen--open")
  );
}

function hideActiveOrderFloatingButton() {
  const btn = document.getElementById("active-order-floating-button");
  if (btn) btn.style.display = "none";
}

function isTrackingScreenVisible() {
  const screen = document.getElementById("tracking-screen");
  if (!screen) return false;
  return window.getComputedStyle(screen).display !== "none";
}

function isStorefrontVisible() {
  return !orderModalIsOpen() && !isTrackingScreenVisible();
}

function showShopUiFromTracking() {
  document.querySelector(".shop-admin-area")?.style.removeProperty("display");
  document.querySelector("main.app")?.style.removeProperty("display");
  const orderScreen = document.getElementById("order-screen");
  if (orderScreen) orderScreen.style.removeProperty("display");
  window.updateCartUI?.();
}

function closeTrackingMapOnly() {
  stopTrackingOrderCompletionPolling();
  _orderTrackingMediaKey = null;
  hideOrderTrackingBanner();

  if (window.trackingInterval) {
    clearInterval(window.trackingInterval);
    window.trackingInterval = null;
  }
  window.courierMarker = null;
  window.deliverymanMarker = null;

  const screen = document.getElementById("tracking-screen");
  if (screen) screen.style.display = "none";
  document.body.style.overflow = "";

  if (window.mapInstance) {
    window.mapInstance.remove();
    window.mapInstance = null;
  }

  showShopUiFromTracking();
}

/** Скрывает плавающую кнопку при уходе с витрины (оформление, трекинг). */
window.showScreen = function showScreen(screenName) {
  const screen = String(screenName || "").toLowerCase();
  if (
    screen === "main" ||
    screen === "store" ||
    screen === "shop" ||
    screen === "catalog"
  ) {
    if (isTrackingScreenVisible()) {
      closeTrackingMapOnly();
    } else {
      showShopUiFromTracking();
    }

    const orderScreen = document.getElementById("order-screen");
    if (orderScreen?.classList.contains("order-screen--open")) {
      orderScreen.classList.remove("order-screen--open");
      orderScreen.setAttribute("aria-hidden", "true");
      window.Telegram?.WebApp?.MainButton?.hide();
    }

    updateActiveOrderFloatingButton();
    return;
  }
  hideActiveOrderFloatingButton();
};

function jsIdForOnclickSingleQuotes(id) {
  return String(id).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function getCartLineQuantity(productId) {
  if (!Array.isArray(window.CART)) return 0;
  const line = window.CART.find((x) => String(x.id) === String(productId));
  if (!line) return 0;
  return Number(line.quantity ?? line.count) || 0;
}

function formatProductCardCountDisplay(product, count) {
  const qty = Number(count) || 0;
  if (qty <= 0) return "0";
  if (product && normalizeUnitType(product.unit_type) === "weight") {
    return formatWeightDisplayText(qty);
  }
  return String(Math.round(qty));
}

function productCountElementId(productId) {
  const safe = String(productId ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `product-count-${safe}`;
}

function findProductCardElement(productId) {
  const id = String(productId ?? "");
  if (!id) return null;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    return document.querySelector(`[data-product-id="${escaped}"]`);
  } catch {
    return null;
  }
}

function stopCartClickEvent(event) {
  if (event == null) return;
  if (typeof event.preventDefault === "function") {
    event.preventDefault();
  }
  if (typeof event.stopPropagation === "function") {
    event.stopPropagation();
  }
}

window.updateProductCardCounter = function (productId) {
  const count = getCartLineQuantity(productId);
  const product = window.STORE_DATA?.products?.find(
    (p) => String(p.id) === String(productId)
  );
  const displayText = formatProductCardCountDisplay(product, count);

  const countEl = document.getElementById(productCountElementId(productId));
  if (countEl) {
    countEl.textContent = displayText;
  }

  const card = findProductCardElement(productId);
  if (!card) return;

  const countDisplay = card.querySelector(".product-count-value");
  if (countDisplay && countDisplay !== countEl) {
    countDisplay.textContent = displayText;
  }

  const addBtn = card.querySelector(".btn-add-plus");
  const qtyWrap = card.querySelector(".product-cart-qty");

  if (addBtn) {
    if (count > 0) {
      addBtn.hidden = true;
    } else {
      addBtn.hidden = false;
      if (addBtn.dataset.addToCartBusy !== "1") {
        addBtn.disabled = false;
        addBtn.textContent = "+";
        addBtn.classList.remove("btn-add-plus--done");
      }
    }
  }

  if (qtyWrap) {
    qtyWrap.hidden = count <= 0;
  }

  const plusBtn = card.querySelector(".btn-plus");
  if (plusBtn) {
    const plusDisabled = isPiecePlusButtonDisabled(productId);
    plusBtn.disabled = plusDisabled;
    plusBtn.classList.toggle("order-qty-btn--disabled", plusDisabled);
    plusBtn.setAttribute("aria-disabled", plusDisabled ? "true" : "false");
  }
};

function refreshAllProductCardCounters() {
  document.querySelectorAll("[data-product-id]").forEach((card) => {
    const id = card.getAttribute("data-product-id");
    if (id) window.updateProductCardCounter(id);
  });
}

function cssEscapeAttrValue(value) {
  const raw = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(raw);
  }
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function patchProductCardCartControls(productId) {
  const card = findProductCardElement(productId);
  if (!card) return;

  const product = getStoreProductById(productId);
  const count = getCartLineQuantity(productId);
  const displayText = formatProductCardCountDisplay(product, count);
  const countSpan = card.querySelector(".product-count-value");
  if (countSpan) countSpan.textContent = displayText;

  const addBtn = card.querySelector(".btn-add-plus");
  const qtyWrap = card.querySelector(".product-cart-qty");
  if (addBtn) addBtn.hidden = count > 0;
  if (qtyWrap) qtyWrap.hidden = count <= 0;

  const plusBtn = card.querySelector(".btn-plus");
  if (plusBtn && product && !isWeightItemProduct(product)) {
    const maxAvailable = getProductStockQuantity(product);
    const isAtLimit = count >= maxAvailable;
    plusBtn.disabled = isAtLimit;
    plusBtn.classList.toggle("order-qty-btn--disabled", isAtLimit);
  }
}

function buildOrderItemRowHtml(item) {
  const idEsc = jsIdForOnclickSingleQuotes(item.id);
  const q = Number(item.quantity ?? item.count) || 0;
  const p = Number(item.price) || 0;
  const lineSum = getCartLineTotal(item);
  const nm = escapeHtml(String(item.name ?? ""));
  const priceLabel = isWeightProduct(item)
    ? `${formatMoney(p)} ₴/100г`
    : `${formatMoney(p)} ₴`;
  const qtyLabel = isWeightProduct(item)
    ? formatWeightDisplayText(q)
    : `${q} шт`;
  const qtyDisplay = isWeightProduct(item)
    ? formatWeightDisplayText(q)
    : String(q);
  const plusDisabled = isPiecePlusButtonDisabled(item.id);
  const plusBtnClass = plusDisabled
    ? "order-qty-btn order-qty-btn--disabled"
    : "order-qty-btn";
  const plusDisabledAttr = plusDisabled ? " disabled" : "";
  const idAttr = escapeHtml(String(item.id ?? ""));

  return `
      <div class="order-item-row" role="listitem" data-order-item-id="${idAttr}">
        <div class="order-item-info">
          <p class="order-item-name">${nm}</p>
          <p class="order-item-meta">${priceLabel} · ${qtyLabel} — ${formatMoney(lineSum)} ₴</p>
        </div>
        <div class="order-item-controls">
          <button type="button" class="order-qty-btn" onclick="window.changeQuantity('${idEsc}', -1)" aria-label="Меньше">-</button>
          <span class="order-qty-value">${escapeHtml(qtyDisplay)}</span>
          <button type="button" class="${plusBtnClass}"${plusDisabledAttr} onclick="window.changeQuantity('${idEsc}', 1)" aria-label="Больше"${plusDisabled ? ' aria-disabled="true"' : ""}>+</button>
          <button type="button" class="order-item-remove order-item-remove--icon" onclick="window.removeFromCart('${idEsc}')" aria-label="Удалить">🗑️</button>
        </div>
      </div>`;
}

function patchOrderModalLine(productId) {
  if (!orderModalIsOpen()) return;

  const list = document.getElementById("order-items-list");
  if (!list) return;

  const id = String(productId ?? "").trim();
  if (!id) {
    window.redrawOrderItemsList();
    return;
  }

  const line = (Array.isArray(window.CART) ? window.CART : []).find(
    (x) => String(x.id) === id
  );
  const row = list.querySelector(
    `[data-order-item-id="${cssEscapeAttrValue(id)}"]`
  );

  if (!line) {
    row?.remove();
    if (!window.CART?.length) {
      list.innerHTML =
        '<p style="text-align:center;opacity:.85;font-size:0.88rem;padding:0.6rem 0">Корзина пуста</p>';
    }
    return;
  }

  const html = buildOrderItemRowHtml(line);
  if (row) {
    row.outerHTML = html;
    return;
  }

  const emptyMsg = list.querySelector("p");
  if (emptyMsg && !list.querySelector(".order-item-row")) {
    list.innerHTML = html;
    return;
  }

  list.insertAdjacentHTML("beforeend", html);
}

function notifyCartLineChanged(productId, options = {}) {
  markCatalogUserInteraction();
  withCartOnlyUiUpdate(() => {
    patchCartBarSummary();

    if (productId != null && productId !== "") {
      window.updateProductCardCounter(productId);
      patchProductCardCartControls(productId);
      revealVisibleCatalogImages();
    }

    if (options.fullOrderList === true && orderModalIsOpen()) {
      window.redrawOrderItemsList();
      return;
    }

    if (orderModalIsOpen()) {
      if (productId != null && productId !== "") {
        patchOrderModalLine(productId);
      } else {
        window.redrawOrderItemsList();
      }
    }
  });
}

/** Короткая блокировка: только счётчики корзины, без блокировки витрины. */
function withCartOnlyUiUpdate(fn) {
  window._cartUiUpdateInProgress = true;
  try {
    return fn();
  } finally {
    window.setTimeout(() => {
      window._cartUiUpdateInProgress = false;
    }, 0);
  }
}

/** Только корзина + счётчики на карточках — без перерисовки витрины/баннера. */
window.updateCartBadge = notifyCartLineChanged;

window.redrawOrderItemsList = function () {
  const list = document.getElementById("order-items-list");
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(window.CART) || !window.CART.length) {
    list.innerHTML =
      '<p style="text-align:center;opacity:.85;font-size:0.88rem;padding:0.6rem 0">Корзина пуста</p>';
    return;
  }

  list.innerHTML = window.CART.map((item) => buildOrderItemRowHtml(item)).join("");
};

window.changeQuantity = function changeQuantity(productId, delta, event) {
  stopCartClickEvent(event);

  const id = String(productId ?? "").trim();
  if (!id) return;

  if (!Array.isArray(window.CART)) {
    window.CART = [];
    return;
  }

  const line = window.CART.find((x) => String(x.id) === id);
  if (!line) return;

  const step = getCartQuantityStep(line);
  const minQty = step;
  const next = (Number(line.quantity) || 0) + delta * step;

  if (next < minQty) {
    window.removeFromCart(id);
    return;
  }

  if (delta > 0 && !isWeightProduct(line)) {
    const product = getStoreProductById(id);
    if (product && !isWeightItemProduct(product)) {
      const maxAvailable = getProductStockQuantity(product);
      const currentInCart = getCurrentCartQuantity(id);
      if (currentInCart >= maxAvailable) {
        showPieceStockLimitAlert(maxAvailable);
        return;
      }
    }
  }

  line.quantity = next;
  if (isWeightProduct(line)) {
    line.count = next;
  }

  tg.HapticFeedback?.impactOccurred?.("light");
  notifyCartLineChanged(id);
};

window.removeFromCart = function (productId) {
  window.CART = window.CART.filter((x) => String(x.id) !== String(productId));
  tg.HapticFeedback?.impactOccurred?.("light");
  if (!window.CART.length && orderModalIsOpen()) {
    patchCartBarSummary();
    window.closeOrderModal();
    return;
  }
  notifyCartLineChanged(productId);
};

const CHECKOUT_LS = {
  inProgress: "checkout_in_progress",
  name: "checkout_name",
  phone: "checkout_phone",
  address: "checkout_address",
  delivery: "checkout_delivery_method",
  lat: "checkout_client_lat",
  lon: "checkout_client_lng",
};

const DNIPRO_PLACES_BOUNDS = {
  north: 48.58,
  south: 48.35,
  east: 35.15,
  west: 34.8,
};

function getCheckoutAddressInput() {
  return (
    document.getElementById("checkout-address") ||
    document.getElementById("client-address")
  );
}

function clearCheckoutLocalStorage() {
  try {
    localStorage.removeItem(CHECKOUT_LS.inProgress);
    localStorage.removeItem(CHECKOUT_LS.name);
    localStorage.removeItem(CHECKOUT_LS.phone);
    localStorage.removeItem(CHECKOUT_LS.address);
    localStorage.removeItem(CHECKOUT_LS.delivery);
    clearCheckoutClientCoordsStorage();
  } catch (e) {
    console.warn("clearCheckoutLocalStorage:", e);
  }
}

function markCheckoutInProgress() {
  try {
    localStorage.setItem(CHECKOUT_LS.inProgress, "true");
  } catch (e) {
    console.warn("markCheckoutInProgress:", e);
  }
}

function bindCheckoutFormPersistence() {
  if (window._checkoutFormPersistenceBound) return;
  window._checkoutFormPersistenceBound = true;

  const nameEl = document.getElementById("client-name");
  const phoneEl = document.getElementById("client-phone");
  const addressEl = getCheckoutAddressInput();
  const deliveryEl = document.getElementById("delivery-method");

  nameEl?.addEventListener("input", (e) => {
    try {
      localStorage.setItem(CHECKOUT_LS.name, e.target.value);
    } catch (err) {
      console.warn(err);
    }
  });
  phoneEl?.addEventListener("input", (e) => {
    try {
      localStorage.setItem(CHECKOUT_LS.phone, e.target.value);
    } catch (err) {
      console.warn(err);
    }
  });
  addressEl?.addEventListener("input", (e) => {
    try {
      localStorage.setItem(CHECKOUT_LS.address, e.target.value);
    } catch (err) {
      console.warn(err);
    }
  });
  deliveryEl?.addEventListener("change", (e) => {
    try {
      localStorage.setItem(CHECKOUT_LS.delivery, e.target.value);
    } catch (err) {
      console.warn(err);
    }
  });
}

function restoreCheckoutFormFields() {
  const nameEl = document.getElementById("client-name");
  const phoneEl = document.getElementById("client-phone");
  const addressEl = getCheckoutAddressInput();
  const deliveryEl = document.getElementById("delivery-method");

  if (nameEl) {
    nameEl.value = localStorage.getItem(CHECKOUT_LS.name) || "";
  }
  if (phoneEl) {
    phoneEl.value = localStorage.getItem(CHECKOUT_LS.phone) || "";
  }
  if (addressEl) {
    addressEl.value = localStorage.getItem(CHECKOUT_LS.address) || "";
  }
  if (deliveryEl) {
    const savedDelivery = localStorage.getItem(CHECKOUT_LS.delivery);
    if (savedDelivery) {
      deliveryEl.value = savedDelivery;
    }
  }
  restoreCheckoutAddressCoordsFromStorage();
  syncDeliveryAddressField();
}

function restoreCheckoutSessionIfNeeded() {
  if (
    TRACKING_MODE ||
    COURIER_DELIVERY_MODE ||
    COURIER_FAST_START_MODE ||
    window.COURIER_FAST_GO_ACTIVE
  ) {
    return;
  }
  if (getActiveOrderId() || loadActiveOrderSnapshot()?.orderId) return;

  let checkoutInProgress = false;
  try {
    checkoutInProgress =
      localStorage.getItem(CHECKOUT_LS.inProgress) === "true";
  } catch (e) {
    console.warn("restoreCheckoutSessionIfNeeded:", e);
    return;
  }

  if (!checkoutInProgress) return;

  console.log(
    "[RESTORE] Обнаружена незавершенная сессия оформления заказа. Восстанавливаем..."
  );

  if (typeof window.openOrderModal === "function") {
    window.openOrderModal();
  }

  setTimeout(() => {
    restoreCheckoutFormFields();
  }, 100);
}

const ACTIVE_ORDER_LS = "halal_active_order_v1";
const ACTIVE_ORDER_ID_LS = "active_order_id";
const LAST_CANCELLED_ORDER_LS = "last_cancelled_order";

const ACTIVE_STOREFRONT_ORDER_STATUSES = new Set([
  "pending_weight_verification",
  "awaiting_payment",
  "delivering",
  "delivery",
  "confirmed",
  "paid",
  "preparing",
  "processing",
  "active",
]);

function normalizeActiveOrderStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "delivering" ? "delivery" : s;
}

function setActiveOrderId(orderId) {
  if (orderId != null && String(orderId).trim()) {
    window.activeOrderId = String(orderId).trim();
    try {
      localStorage.setItem(ACTIVE_ORDER_ID_LS, window.activeOrderId);
    } catch (e) {
      console.warn("setActiveOrderId:", e);
    }
    return;
  }
  window.activeOrderId = null;
  try {
    localStorage.removeItem(ACTIVE_ORDER_ID_LS);
  } catch (e) {
    console.warn("setActiveOrderId:", e);
  }
}

function getActiveOrderId() {
  if (window.activeOrderId) return String(window.activeOrderId);
  try {
    const stored = localStorage.getItem(ACTIVE_ORDER_ID_LS);
    return stored ? String(stored) : null;
  } catch {
    return null;
  }
}

function isActiveStorefrontOrderStatus(status) {
  return ACTIVE_STOREFRONT_ORDER_STATUSES.has(
    normalizeActiveOrderStatus(status)
  );
}

function trackingFromActiveOrderApi(order) {
  if (!order) return null;
  const orderId = String(order.order_id || order.id || "").trim();
  if (!orderId) return null;
  const status = normalizeActiveOrderStatus(order.status);
  return {
    orderId,
    isDelivery: Boolean(order.is_delivery),
    clientLat:
      order.client_lat != null
        ? Number(order.client_lat)
        : order.client_latitude != null
          ? Number(order.client_latitude)
          : null,
    clientLon:
      order.client_lon != null
        ? Number(order.client_lon)
        : order.client_longitude != null
          ? Number(order.client_longitude)
          : null,
    shopLat:
      order.shop_latitude != null
        ? Number(order.shop_latitude)
        : SHOP_TRACK_LAT,
    shopLon:
      order.shop_longitude != null
        ? Number(order.shop_longitude)
        : SHOP_TRACK_LON,
    totalPrice:
      order.total_price != null ? Number(order.total_price) : null,
    lastStatus: status,
    canTrackCourier:
      order.can_track_courier === true ||
      status === "delivery" ||
      status === "delivering",
  };
}

let _activeOrderCheckRetryTimer = null;

function scheduleActiveOrderCheckRetry(delayMs = 600) {
  if (_activeOrderCheckRetryTimer != null) return;
  _activeOrderCheckRetryTimer = window.setTimeout(() => {
    _activeOrderCheckRetryTimer = null;
    checkActiveUserOrder({ maxWaitMs: 4000 });
  }, delayMs);
}

/** Восстановление активного заказа с сервера (не зависит от localStorage). */
function scheduleActiveOrderRecovery() {
  const run = () => {
    checkActiveUserOrder({ maxWaitMs: 6000 });
  };
  if (typeof tg?.ready === "function") {
    tg.ready(run);
  } else {
    run();
  }
}

async function checkActiveUserOrder(options = {}) {
  if (
    TRACKING_MODE ||
    COURIER_DELIVERY_MODE ||
    COURIER_FAST_START_MODE ||
    window.COURIER_FAST_GO_ACTIVE
  ) {
    return;
  }

  const userId =
    options.userId != null && String(options.userId).trim()
      ? String(options.userId).trim()
      : await waitForTelegramUserId(options.maxWaitMs ?? 5000);

  if (!userId) {
    scheduleActiveOrderCheckRetry();
    return;
  }

  try {
    const res = await fetch(
      `/api/orders/active?user_id=${encodeURIComponent(String(userId))}`
    );
    const data = await parseJsonResponse(res);

    if (!res.ok || data.has_active === false || !data.has_active) {
      const orderBtn = document.getElementById("active-order-floating-button");
      if (orderBtn) orderBtn.style.display = "none";

      stopOrderStatusPolling();
      window._activeOrderTracking = null;
      window._orderStatusUiPhase = null;
      setActiveOrderId(null);
      clearActiveOrderSnapshot();

      if (data.was_cancelled === true) {
        const cancelledId = String(data.order_id || "");
        if (
          cancelledId &&
          localStorage.getItem(LAST_CANCELLED_ORDER_LS) !== cancelledId
        ) {
          const cancelMessage =
            "Ваш заказ был удален или отменен администратором.";
          if (window.Telegram?.WebApp?.showPopup) {
            window.Telegram.WebApp.showPopup({
              title: "Статус заказа",
              message: cancelMessage,
              buttons: [{ id: "ok", type: "ok" }],
            });
          } else {
            alert(cancelMessage);
          }
          localStorage.setItem(LAST_CANCELLED_ORDER_LS, cancelledId);

          if (typeof window.showScreen === "function") {
            window.showScreen("main");
          }
        }
      }
      return;
    }

    if (!data.order_id) {
      const orderBtn = document.getElementById("active-order-floating-button");
      if (orderBtn) orderBtn.style.display = "none";
      setActiveOrderId(null);
      clearActiveOrderSnapshot();
      return;
    }

    const orderId = String(data.order_id || "");
    const status = normalizeActiveOrderStatus(data.status);
    if (!isActiveStorefrontOrderStatus(status)) {
      setActiveOrderId(null);
      clearActiveOrderSnapshot();
      document.getElementById("active-order-floating-button").style.display =
        "none";
      return;
    }

    setActiveOrderId(orderId);

    let tracking = null;
    try {
      const statusRes = await fetch(
        `/api/order_status?order_id=${encodeURIComponent(orderId)}`
      );
      const statusData = await parseJsonResponse(statusRes);
      if (statusData?.ok) {
        tracking = trackingFromActiveOrderApi({
          order_id: orderId,
          id: orderId,
          status: statusData.status || status,
          is_delivery:
            statusData.client_lat != null ||
            statusData.client_latitude != null ||
            status === "delivery" ||
            status === "delivering" ||
            status === "active",
          ...statusData,
        });
      }
    } catch (statusErr) {
      console.warn("checkActiveUserOrder: order_status", statusErr);
    }

    if (!tracking) {
      tracking = {
        orderId,
        isDelivery: false,
        clientLat: null,
        clientLon: null,
        shopLat: SHOP_TRACK_LAT,
        shopLon: SHOP_TRACK_LON,
        totalPrice: null,
        lastStatus: status,
      };
    }

    saveActiveOrderSnapshot(tracking, status);
    if (
      !window._activeOrderTracking?.orderId ||
      String(window._activeOrderTracking.orderId) !== orderId
    ) {
      startOrderStatusPolling(tracking, {
        initialStatus: status,
        skipDefaultAssembling: true,
      });
    } else {
      window._activeOrderTracking = {
        ...window._activeOrderTracking,
        ...tracking,
      };
      if (isStorefrontVisible()) {
        updateActiveOrderFloatingButton(status);
      } else {
        hideActiveOrderFloatingButton();
      }
    }

    if (isStorefrontVisible()) {
      updateActiveOrderFloatingButton(status);
    }
  } catch (err) {
    console.error("checkActiveUserOrder:", err);
    const orderBtn = document.getElementById("active-order-floating-button");
    if (orderBtn) orderBtn.style.display = "none";
    scheduleActiveOrderCheckRetry(1200);
  }
}

window.checkActiveUserOrder = checkActiveUserOrder;

function loadActiveOrderSnapshot() {
  try {
    const raw = localStorage.getItem(ACTIVE_ORDER_LS);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && data.orderId ? data : null;
  } catch {
    return null;
  }
}

function saveActiveOrderSnapshot(tracking, status) {
  if (!tracking?.orderId) return;
  setActiveOrderId(tracking.orderId);
  const payload = {
    orderId: String(tracking.orderId),
    isDelivery: Boolean(tracking.isDelivery),
    clientLat: tracking.clientLat ?? null,
    clientLon: tracking.clientLon ?? null,
    shopLat: tracking.shopLat ?? SHOP_TRACK_LAT,
    shopLon: tracking.shopLon ?? SHOP_TRACK_LON,
    totalPrice: tracking.totalPrice ?? null,
    lastStatus: status || tracking.lastStatus || "",
  };
  try {
    localStorage.setItem(ACTIVE_ORDER_LS, JSON.stringify(payload));
  } catch (e) {
    console.warn("saveActiveOrderSnapshot:", e);
  }
}

function clearActiveOrderSnapshot() {
  setActiveOrderId(null);
  try {
    localStorage.removeItem(ACTIVE_ORDER_LS);
  } catch (e) {
    console.warn("clearActiveOrderSnapshot:", e);
  }
}

function hasActiveOrderInProgress() {
  const orderId = getActiveOrderId();
  const tracking = window._activeOrderTracking || loadActiveOrderSnapshot();
  if (!orderId && !tracking?.orderId) return false;
  const status = tracking?.lastStatus || "";
  return isActiveStorefrontOrderStatus(status);
}

function activeOrderFloatingButtonLabel(status) {
  const s = String(status || "").toLowerCase();
  const map = {
    pending_weight_verification: "Ваш заказ взвешивается",
    awaiting_payment: "Заказ готов к оплате",
    paid: "Заказ оплачен, ожидаем курьера",
    confirmed: "Заказ подтверждён, ожидаем курьера",
    preparing: "Заказ готовится к отправке",
    processing: "Ваш заказ обрабатывается",
    active: "Курьер назначен на ваш заказ",
    delivery: "Ваш заказ доставляется",
  };
  return map[s] || "Ваш заказ обрабатывается / доставляется";
}

function updateActiveOrderFloatingButton(status) {
  const btn = document.getElementById("active-order-floating-button");
  if (!btn) return;

  if (!isStorefrontVisible()) {
    btn.style.display = "none";
    return;
  }

  const tracking = window._activeOrderTracking || loadActiveOrderSnapshot();
  const orderStatus = status || tracking?.lastStatus || "";
  const completed = String(orderStatus).toLowerCase() === "completed";

  if (!tracking?.orderId || completed) {
    btn.style.display = "none";
    return;
  }

  const cartPanel = document.getElementById("cart-checkout-panel");
  const cartVisible = cartPanel?.classList.contains("cart-checkout-panel--visible");
  btn.classList.toggle("active-order-floating-btn--above-cart", Boolean(cartVisible));

  const textEl = btn.querySelector(".btn-text");
  if (textEl) {
    textEl.textContent = activeOrderFloatingButtonLabel(orderStatus);
  }
  btn.style.display = "block";
}

window.goToActiveOrderTrack = async function goToActiveOrderTrack() {
  hideActiveOrderFloatingButton();

  let tracking = window._activeOrderTracking;
  const knownOrderId = getActiveOrderId();

  if (!tracking?.orderId && knownOrderId) {
    const saved = loadActiveOrderSnapshot();
    if (saved?.orderId === knownOrderId) {
      tracking = {
        orderId: String(saved.orderId),
        isDelivery: Boolean(saved.isDelivery),
        clientLat: saved.clientLat,
        clientLon: saved.clientLon,
        shopLat: saved.shopLat ?? SHOP_TRACK_LAT,
        shopLon: saved.shopLon ?? SHOP_TRACK_LON,
        totalPrice: saved.totalPrice,
        lastStatus: saved.lastStatus || "",
      };
    }
  }

  if (!tracking?.orderId) {
    await checkActiveUserOrder();
    tracking = window._activeOrderTracking;
  }

  if (!tracking?.orderId) return;

  const el = document.getElementById("order-screen");
  if (!el) return;

  const form = document.getElementById("order-client-form");
  if (form) form.classList.add("is-hidden");

  el.classList.add("order-screen--open");
  el.setAttribute("aria-hidden", "false");

  if (window.Telegram?.WebApp?.MainButton) {
    window.Telegram.WebApp.MainButton.hide();
  }

  if (!orderStatusPollInterval) {
    pollActiveOrderStatus();
    orderStatusPollInterval = setInterval(pollActiveOrderStatus, 4000);
  } else {
    pollActiveOrderStatus();
  }

  hideActiveOrderFloatingButton();
};

let orderStatusPollInterval = null;
window._activeOrderTracking = null;
window._orderStatusUiPhase = null;

function stopOrderStatusPolling() {
  if (orderStatusPollInterval) {
    clearInterval(orderStatusPollInterval);
    orderStatusPollInterval = null;
  }
}

function resetOrderStatusView() {
  stopOrderStatusPolling();
  window._activeOrderTracking = null;
  window._orderStatusUiPhase = null;
  clearActiveOrderSnapshot();
  updateActiveOrderFloatingButton();

  const form = document.getElementById("order-client-form");
  const statusBox = document.getElementById("order-status-container");
  if (form) {
    form.classList.remove("is-hidden");
  }
  if (statusBox) {
    statusBox.classList.remove("is-visible");
    statusBox.setAttribute("aria-hidden", "true");
    statusBox.innerHTML = "";
  }
  const actionBtn = document.getElementById("dynamic-action-btn");
  if (actionBtn) {
    actionBtn.style.display = "none";
    actionBtn.disabled = true;
    actionBtn.classList.remove("ready-to-pay");
    actionBtn.onclick = null;
  }
}

function hideOrderPaymentButton() {
  if (window.Telegram?.WebApp?.MainButton) {
    window.Telegram.WebApp.MainButton.hide();
  }
}

window.adminUpdateOrderWeights = async function (orderId, items) {
  if (!IS_ADMIN) return;
  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram.");
    return null;
  }
  try {
    const res = await fetch(
      `/api/admin/orders/${encodeURIComponent(orderId)}/update_weights`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ user_id: userId, items }),
      }
    );
    const data = await parseJsonResponse(res);
    if (!res.ok || data.success === false) {
      tg.showAlert(data.error || "Не удалось обновить веса.");
      return null;
    }
    const updatedTotal = data.new_total_price ?? data.total_price;
    tg.showAlert(`Чек обновлён. Сумма: ${formatPriceUi(updatedTotal)} ₴`);
    return data;
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети.");
    return null;
  }
};

window.handleOrderPaymentClick = async function () {
  const tracking = window._activeOrderTracking;
  const orderId = tracking?.orderId ? String(tracking.orderId) : "";
  const userId = getTelegramUserId();

  if (!orderId) {
    tg.showAlert?.("Не найден номер заказа.");
    return;
  }
  if (!userId) {
    tg.showAlert?.("Откройте приложение в Telegram.");
    return;
  }

  try {
    const res = await fetch("/api/order/confirm_payment", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ order_id: orderId, user_id: String(userId) }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.ok === false || data.success === false) {
      tg.showAlert?.(data.error || "Не удалось подтвердить оплату.");
      return;
    }

    if (data.total_price != null && tracking) {
      tracking.totalPrice = Number(data.total_price);
    }
    hideOrderPaymentButton();
    await pollActiveOrderStatus();
    tg.HapticFeedback?.notificationOccurred?.("success");
    tg.showAlert?.("Оплата принята! Ожидайте курьера.");
  } catch (e) {
    console.error(e);
    tg.showAlert?.("Ошибка сети при оплате.");
  }
};

function updateDynamicActionButton(order) {
  const actionBtn = document.getElementById("dynamic-action-btn");
  if (!actionBtn) return;

  const status = String(order?.status || "").toLowerCase();
  const orderId =
    order?.id ||
    order?.order_id ||
    window._activeOrderTracking?.orderId ||
    "";

  actionBtn.onclick = null;
  actionBtn.classList.remove("ready-to-pay");

  if (status === "pending_weight_verification") {
    actionBtn.style.display = "block";
    actionBtn.innerText = "Ваш заказ взвешивается...";
    actionBtn.disabled = true;
    return;
  }

  if (status === "awaiting_payment") {
    actionBtn.style.display = "block";
    actionBtn.innerText = "Ваш заказ взвешен, перейти к оплате";
    actionBtn.disabled = false;
    actionBtn.classList.add("ready-to-pay");
    actionBtn.onclick = function () {
      window.processOrderPayment(orderId);
    };
    return;
  }

  actionBtn.style.display = "none";
  actionBtn.disabled = true;
}

window.processOrderPayment = function processOrderPayment(orderId) {
  const oid = String(orderId || window._activeOrderTracking?.orderId || "").trim();
  if (oid && window._activeOrderTracking) {
    window._activeOrderTracking.orderId = oid;
  }
  return window.handleOrderPaymentClick();
};

function bindTrackOrderButton() {
  const trackBtn = document.getElementById("btn-track-order");
  if (!trackBtn) return;
  trackBtn.addEventListener("click", () => {
    const tracking = window._activeOrderTracking;
    if (!tracking?.orderId) return;
    window.showTrackingMap(
      tracking.clientLat,
      tracking.clientLon,
      tracking.orderId,
      tracking.shopLat,
      tracking.shopLon
    );
  });
}

function renderOrderPendingWeightVerificationStatus() {
  const form = document.getElementById("order-client-form");
  const statusBox = document.getElementById("order-status-container");
  if (form) {
    form.classList.add("is-hidden");
  }
  if (statusBox) {
    statusBox.innerHTML = `
      <h3>Весовые товары в заказе</h3>
      <p class="order-weight-pending-banner" role="status">
        ⏳ Взвешиваем весовые товары. В магазине собирают ваш заказ. Как только фактический вес будет указан, сумма обновится, и вы сможете оплатить заказ.
      </p>
    `;
    statusBox.classList.add("is-visible");
    statusBox.setAttribute("aria-hidden", "false");
  }
  window._orderStatusUiPhase = "pending_weight";
}

function renderOrderAwaitingPaymentStatus(totalPrice) {
  const form = document.getElementById("order-client-form");
  const statusBox = document.getElementById("order-status-container");
  if (form) {
    form.classList.add("is-hidden");
  }
  const totalLabel =
    totalPrice != null && !Number.isNaN(Number(totalPrice))
      ? `${formatPriceUi(Number(totalPrice))} ₴`
      : null;
  if (statusBox) {
    statusBox.innerHTML = `
      <h3>Заказ готов к оплате</h3>
      <p>Вес проверен. Ниже — итоговая сумма с учётом фактического веса.</p>
      ${
        totalLabel
          ? `<p class="order-status-total">Итого к оплате: <strong>${escapeHtml(totalLabel)}</strong></p>`
          : `<p class="order-status-total">Сумма чека обновляется…</p>`
      }
    `;
    statusBox.classList.add("is-visible");
    statusBox.setAttribute("aria-hidden", "false");
  }
  window._orderStatusUiPhase = "awaiting_payment";
}

function isOrderPaidNotYetDelivering(status) {
  const s = normalizeActiveOrderStatus(status);
  return (
    s === "paid" ||
    s === "confirmed" ||
    s === "preparing" ||
    s === "processing"
  );
}

function renderOrderAwaitingCourierStatus(orderStatus) {
  const form = document.getElementById("order-client-form");
  const statusBox = document.getElementById("order-status-container");
  const status = normalizeActiveOrderStatus(
    orderStatus ||
      window._activeOrderTracking?.lastStatus ||
      ""
  );
  const paidAwaitingCourier = isOrderPaidNotYetDelivering(status);

  if (form) {
    form.classList.add("is-hidden");
  }
  if (statusBox) {
    if (paidAwaitingCourier) {
      statusBox.innerHTML = `
        <div class="order-status-spinner" aria-hidden="true"></div>
        <h3>Заказ оплачен, ожидаем курьера</h3>
      `;
    } else {
      statusBox.innerHTML = `
        <div class="order-status-spinner" aria-hidden="true"></div>
        <h3>Курьер назначен</h3>
        <p>Курьер принял заказ. Когда курьер нажмёт «Поехали», здесь появится кнопка отслеживания на карте.</p>
      `;
    }
    statusBox.classList.add("is-visible");
    statusBox.setAttribute("aria-hidden", "false");
  }
  window._orderStatusUiPhase = paidAwaitingCourier
    ? "paid_awaiting_courier"
    : "awaiting_courier";
}

function renderOrderAssemblingStatus() {
  const form = document.getElementById("order-client-form");
  const statusBox = document.getElementById("order-status-container");
  if (form) {
    form.classList.add("is-hidden");
  }
  if (statusBox) {
    statusBox.innerHTML = `
      <div class="order-status-spinner" aria-hidden="true"></div>
      <h3>Собираем заказ</h3>
      <p>Пожалуйста, не закрывайте это окно, мы уже готовим ваши продукты.</p>
    `;
    statusBox.classList.add("is-visible");
    statusBox.setAttribute("aria-hidden", "false");
  }
  window._orderStatusUiPhase = "assembling";
}

function renderOrderOnTheWayStatus() {
  const statusBox = document.getElementById("order-status-container");
  if (!statusBox) return;

  const tracking = window._activeOrderTracking;
  const trackBtnHtml =
    tracking?.isDelivery && tracking?.canTrackCourier !== false
      ? '<button type="button" id="btn-track-order" class="btn-track-order">Отследить заказ</button>'
      : "";

  statusBox.innerHTML = `
    <div class="order-status-spinner" aria-hidden="true"></div>
    <h3>Заказ в пути!</h3>
    <p>Курьер уже везёт ваш заказ. Нажмите кнопку ниже, чтобы открыть карту.</p>
    ${trackBtnHtml}
  `;
  statusBox.classList.add("is-visible");
  statusBox.setAttribute("aria-hidden", "false");
  window._orderStatusUiPhase = "on_the_way";
  bindTrackOrderButton();
}

function renderOrderCompletedStatus() {
  const statusBox = document.getElementById("order-status-container");
  if (!statusBox) return;
  statusBox.innerHTML = `
    <h3>Заказ доставлен!</h3>
    <p>Спасибо, что выбрали нас. Приятного аппетита!</p>
  `;
  statusBox.classList.add("is-visible");
  statusBox.setAttribute("aria-hidden", "false");
  window._orderStatusUiPhase = "completed";
  stopOrderStatusPolling();
  if (window._activeOrderTracking) {
    window._activeOrderTracking.lastStatus = "completed";
  }
  clearActiveOrderSnapshot();
  updateActiveOrderFloatingButton("completed");
}

function isCourierTrackingViewMode() {
  return (
    new URLSearchParams(window.location.search).get("courier_view") === "1"
  );
}

function isCourierMapTrackingAvailable(data) {
  if (isCourierTrackingViewMode()) return true;
  if (!data || data.ok === false) return false;
  if (data.courier_route_mode === true || data.can_track_courier === true) {
    return true;
  }
  const status = String(data.status || "").toLowerCase();
  return status === "delivery" || status === "delivering";
}

function renderOrderStatus(data) {
  if (!data?.ok) return;

  const status = String(data.status || "").toLowerCase();
  const tracking = window._activeOrderTracking;

  if (status === "cancelled" || status === "deleted") {
    handleOrderCancelled(tracking?.orderId || data.order_id);
    return;
  }
  if (tracking && data.total_price != null) {
    tracking.totalPrice = Number(data.total_price);
  }
  if (tracking) {
    tracking.canTrackCourier = isCourierMapTrackingAvailable(data);
    tracking.lastStatus = status;
    saveActiveOrderSnapshot(tracking, status);
  }

  updateActiveOrderFloatingButton(status);

  if (status === "completed") {
    renderOrderCompletedStatus();
  } else if (status === "pending_weight_verification") {
    renderOrderPendingWeightVerificationStatus();
  } else if (status === "awaiting_payment") {
    renderOrderAwaitingPaymentStatus(tracking?.totalPrice ?? data.total_price);
  } else if (status === "delivery" || status === "delivering") {
    renderOrderOnTheWayStatus();
  } else if (
    status === "paid" ||
    status === "confirmed" ||
    status === "preparing" ||
    status === "processing" ||
    status === "active"
  ) {
    renderOrderAwaitingCourierStatus(status);
  } else if (window._orderStatusUiPhase !== "on_the_way") {
    renderOrderAssemblingStatus();
  }

  updateDynamicActionButton({
    status,
    id: tracking?.orderId || data.order_id,
    order_id: tracking?.orderId || data.order_id,
    total_price: tracking?.totalPrice ?? data.total_price,
  });
}

function handleOrderCancelled(orderId) {
  if (window._cancelledHandled === orderId) return;
  window._cancelledHandled = orderId;

  updateDynamicActionButton({ status: "cancelled", order_id: orderId });

  clearActiveOrderSnapshot();
  setActiveOrderId(null);
  stopOrderStatusPolling();
  window._activeOrderTracking = null;
  window._orderStatusUiPhase = null;

  if (orderModalIsOpen()) {
    window.closeOrderModal();
  }
  hideActiveOrderFloatingButton();

  const message =
    "❌ Ваш заказ был отменён администратором. Вы можете сделать новый заказ.";
  if (typeof tg?.showAlert === "function") {
    tg.showAlert(message);
  } else {
    alert(message);
  }

  window.updateCartUI();

  setTimeout(() => {
    if (window._cancelledHandled === orderId) {
      window._cancelledHandled = null;
    }
  }, 5000);
}

async function pollActiveOrderStatus() {
  const tracking = window._activeOrderTracking;
  if (!tracking?.orderId) return;

  try {
    const res = await fetch(
      `/api/order_status?order_id=${encodeURIComponent(tracking.orderId)}`
    );
    const data = await parseJsonResponse(res);
    if (!data?.ok) return;

    const status = String(data.status || "").toLowerCase();
    if (status === "cancelled" || status === "deleted") {
      handleOrderCancelled(tracking.orderId);
      return;
    }

    applyRouteCoordsFromApiPayload(tracking, data);
    renderOrderTrackingBanner(data);
    renderOrderStatus(data);
  } catch (err) {
    console.error("order_status poll:", err);
  }
}

function startOrderStatusPolling(tracking, options = {}) {
  stopOrderStatusPolling();
  window._activeOrderTracking = tracking;
  tracking.lastStatus = String(options.initialStatus || tracking.lastStatus || "");
  saveActiveOrderSnapshot(tracking, tracking.lastStatus);

  const initialStatus = String(options.initialStatus || "").toLowerCase();
  if (initialStatus) {
    renderOrderStatus({
      ok: true,
      status: initialStatus,
      total_price: tracking.totalPrice,
      can_track_courier:
        initialStatus === "delivery" || initialStatus === "delivering",
    });
  } else if (!options.skipDefaultAssembling) {
    renderOrderStatus({
      ok: true,
      status: "processing",
      total_price: tracking.totalPrice,
    });
  }

  pollActiveOrderStatus();
  orderStatusPollInterval = setInterval(pollActiveOrderStatus, 4000);
  updateActiveOrderFloatingButton(tracking.lastStatus);
}

function beginOrderStatusFlowAfterSubmit(orderId, isDelivery, routePayload) {
  const lat =
    window.SELECTED_LAT != null ? Number(window.SELECTED_LAT) : null;
  const lon =
    window.SELECTED_LON != null ? Number(window.SELECTED_LON) : null;

  const tracking = {
    orderId: String(orderId),
    isDelivery: Boolean(isDelivery),
    clientLat: Number.isNaN(lat) ? null : lat,
    clientLon: Number.isNaN(lon) ? null : lon,
    shopLat: SHOP_TRACK_LAT,
    shopLon: SHOP_TRACK_LON,
    totalPrice:
      routePayload?.total_price != null
        ? Number(routePayload.total_price)
        : null,
    hasWeightItems: Boolean(routePayload?.has_weight_items),
  };
  applyRouteCoordsFromApiPayload(tracking, routePayload);

  const initialStatus = String(routePayload?.status || "").toLowerCase();
  startOrderStatusPolling(tracking, { initialStatus });

  const el = document.getElementById("order-screen");
  if (el) {
    const form = document.getElementById("order-client-form");
    if (form) form.classList.add("is-hidden");
    el.classList.add("order-screen--open");
    el.setAttribute("aria-hidden", "false");
    if (window.Telegram?.WebApp?.MainButton) {
      window.Telegram.WebApp.MainButton.hide();
    }
  }
  hideActiveOrderFloatingButton();
}

window.openOrderModal = function () {
  if (hasActiveOrderInProgress()) {
    window.goToActiveOrderTrack();
    return;
  }
  hideActiveOrderFloatingButton();
  resetOrderStatusView();
  const el = document.getElementById("order-screen");
  if (!el) return;
  el.classList.add("order-screen--open");
  el.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      window.redrawOrderItemsList();
      initAddressAutocomplete();
      if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.MainButton.setText("ОТПРАВИТЬ ЗАКАЗ");
        window.Telegram.WebApp.MainButton.show();
        window.Telegram.WebApp.MainButton.onClick(window.sendOrderToTelegram);
      }
    });
  });
  markCheckoutInProgress();
};

window.closeOrderModal = function () {
  const el = document.getElementById("order-screen");
  if (!el) return;
  el.classList.remove("order-screen--open");
  el.setAttribute("aria-hidden", "true");
  if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.MainButton.hide();
  }
  clearCheckoutLocalStorage();

  if (hasActiveOrderInProgress()) {
    updateActiveOrderFloatingButton(
      window._activeOrderTracking?.lastStatus ||
        loadActiveOrderSnapshot()?.lastStatus
    );
    return;
  }

  resetOrderStatusView();
};

window.applyClientPromocode = function () {
  const codeInput = document.getElementById("client-promo-input");
  const statusDiv = document.getElementById("promo-status-message");
  if (!codeInput) return;

  const code = codeInput.value.trim();
  if (!code) {
    if (statusDiv) {
      statusDiv.style.display = "block";
      statusDiv.style.color = "#dc3545";
      statusDiv.innerText = "Введите код!";
    }
    return;
  }

  fetch("/api/validate_promocode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.success) {
        window.activePromoCode = String(data.code || code).toUpperCase();
        window.activePromoDiscount = normalizeProductDiscount(
          data.discount_percent
        );
        if (statusDiv) {
          statusDiv.style.display = "block";
          statusDiv.style.color = "#28a745";
          statusDiv.innerText = `Промокод успешно применен! Скидка ${window.activePromoDiscount}%`;
        }

        patchCartBarSummary();
        notifyCartLineChanged(null, { fullOrderList: true });
      } else {
        window.activePromoCode = "";
        window.activePromoDiscount = 0;
        if (statusDiv) {
          statusDiv.style.display = "block";
          statusDiv.style.color = "#dc3545";
          statusDiv.innerText = data.error || "Промокод не найден";
        }
        patchCartBarSummary();
        notifyCartLineChanged(null, { fullOrderList: true });
      }
    })
    .catch((err) => {
      console.error(err);
      if (statusDiv) {
        statusDiv.style.display = "block";
        statusDiv.style.color = "#dc3545";
        statusDiv.innerText = "Ошибка соединения с сервером";
      }
    });
};

window.applyPromocode = window.applyClientPromocode;

function getAdminUserId() {
  return tg.initDataUnsafe?.user?.id || window.ADMIN_USER_ID || "";
}

window.loadAdminPromocodes = async function () {
  const listEl = document.getElementById("admin-promocodes-list");
  if (!listEl) return;

  const userId = getAdminUserId();
  if (!userId) {
    listEl.innerHTML = "<p class=\"catalog-empty\">Нет ID администратора</p>";
    return;
  }

  listEl.textContent = "Загрузка…";

  try {
    const res = await fetch(
      `/api/admin/promocodes?user_id=${encodeURIComponent(String(userId))}`
    );
    const data = await res.json();
    if (!data.success) {
      listEl.innerHTML = `<p class="catalog-empty">${escapeHtml(data.error || "Ошибка загрузки")}</p>`;
      return;
    }

    const codes = Array.isArray(data.promocodes) ? data.promocodes : [];
    if (!codes.length) {
      listEl.innerHTML = "<p class=\"catalog-empty\">Промокодов пока нет</p>";
      return;
    }

    listEl.innerHTML = codes
      .map((item) => {
        const code = escapeHtml(String(item.code || ""));
        const pct = normalizeProductDiscount(item.discount_percent);
        const codeJs = jsIdForOnclickSingleQuotes(item.code || "");
        return `
          <div class="admin-promocode-row">
            <span class="admin-promocode-code">${code}</span>
            <span class="admin-promocode-pct">−${pct}%</span>
            <button type="button" class="btn-delete-promocode" onclick="window.deleteAdminPromocode('${codeJs}')">Удалить</button>
          </div>`;
      })
      .join("");
  } catch {
    listEl.innerHTML = "<p class=\"catalog-empty\">Ошибка загрузки</p>";
  }
};

function parsePromocodeMaxUses(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return 100;
  }
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 1 ? n : 100;
}

window.addAdminPromocode = async function () {
  if (!IS_ADMIN) return;

  const codeEl =
    document.getElementById("promo-code-input") ||
    document.getElementById("admin-new-promocode-code");
  const pctEl =
    document.getElementById("promo-discount-input") ||
    document.getElementById("admin-new-promocode-percent");
  const maxUsesEl =
    document.getElementById("promo-max-uses-input") ||
    document.getElementById("admin-new-promocode-max-uses");
  const code = codeEl ? String(codeEl.value || "").trim().toUpperCase() : "";
  const discountPercent = normalizeProductDiscount(
    pctEl ? pctEl.value : 0
  );
  const maxUses = parsePromocodeMaxUses(maxUsesEl ? maxUsesEl.value : null);

  if (!code) {
    alert("Введите текст промокода");
    return;
  }
  if (discountPercent <= 0) {
    alert("Укажите скидку больше 0%");
    return;
  }

  const userId = getAdminUserId();
  if (!userId) {
    alert("Не удалось определить ID администратора");
    return;
  }

  try {
    const res = await fetch("/api/admin/add_promocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        code,
        discount_percent: discountPercent,
        max_uses: maxUses,
      }),
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.error || "Не удалось создать промокод");
      return;
    }
    if (codeEl) codeEl.value = "";
    if (pctEl) pctEl.value = "";
    await window.loadAdminPromocodes();
    tg.HapticFeedback?.impactOccurred?.("light");
  } catch {
    alert("Ошибка сети");
  }
};

window.createPromocode = window.addAdminPromocode;

window.deleteAdminPromocode = async function (code) {
  if (!IS_ADMIN || !code) return;
  if (!confirm(`Удалить промокод ${code}?`)) return;

  const userId = getAdminUserId();
  if (!userId) return;

  try {
    const res = await fetch("/api/admin/delete_promocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, code }),
    });
    const data = await res.json();
    if (!data.success) {
      alert(data.error || "Не удалось удалить");
      return;
    }
    await window.loadAdminPromocodes();
  } catch {
    alert("Ошибка сети");
  }
};

window.sendOrderToTelegram = function () {
  try {
    const nameEl = document.getElementById("client-name");
    const phoneEl = document.getElementById("client-phone");
    const deliveryEl = document.getElementById("delivery-method");
    const addressField = getCheckoutAddressInput();

    const name = nameEl ? nameEl.value.trim() : "";
    const phone = phoneEl ? phoneEl.value.trim() : "";
    const delivery = deliveryEl ? deliveryEl.value : "pickup";
    const address = addressField ? addressField.value.trim() : "";

    if (!name || !phone) {
      alert("Пожалуйста, заполните Имя и Номер телефона!");
      return;
    }

    if (!window.CART.length) {
      alert("Корзина пуста.");
      return;
    }

    const isDelivery = delivery === "delivery" || delivery === "courier";
    if (isDelivery && !address) {
      alert("Пожалуйста, укажите адрес доставки!");
      return;
    }

    let itemsText = "";
    let total = getCartTotalWithPromo();

    window.CART.forEach((item, index) => {
      const lineTotal = getCartLineTotal(item);
      const lineDisc = normalizeProductDiscount(item.discount);
      const discNote = lineDisc > 0 ? ` (-${lineDisc}%)` : "";
      const qtyPart = isWeightProduct(item)
        ? formatWeightDisplayText(item.quantity ?? item.count)
        : `x${Number(item.quantity) || 0}`;
      itemsText += `${index + 1}. ${item.name} — ${qtyPart} — ${formatPriceUi(lineTotal)} ₴${discNote}\n`;
    });

    const promoDiscountAmount = getCartPromoDiscountAmount();
    const promoLine =
      window.activePromoDiscount > 0 && window.activePromoCode
        ? `\n🏷️ Промокод ${window.activePromoCode}: −${window.activePromoDiscount}%\n💚 Скидка по промокоду: -${formatPriceUi(promoDiscountAmount)} грн`
        : "";

    const orderData = `🛍️ НОВЫЙ ЗАКАЗ\n\n👤 Имя: ${name}\n📞 Телефон: ${phone}\n🚚 Доставка: ${isDelivery ? "Курьер" : "Самовывоз"}\n${isDelivery ? "🏠 Адрес: " + address + "\n" : ""}\n🛒 Товары:\n${itemsText}${promoLine}\n💰 Итого: ${formatPriceUi(total)} ₴`;

    const bodyData = {
      chat_id: window.Telegram?.WebApp?.initDataUnsafe?.user?.id || null,
      order_text: orderData,
      order_total: total,
      delivery_method: delivery,
      delivery_address: isDelivery ? address : "",
      cart: window.CART.map((item) => ({
        id: item.id,
        name: item.name,
        price: item.price,
        quantity: item.quantity ?? item.count,
        count: item.quantity ?? item.count,
        unit_type: normalizeUnitType(item.unit_type),
        price_per_unit: item.price_per_unit || (isWeightProduct(item) ? "100g" : "pcs"),
        discount: normalizeProductDiscount(item.discount),
      })),
      promocode: window.activePromoCode || "",
      ...getCheckoutClientCoordsForSubmit(),
    };

    fetch("/api/submit_order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyData),
    })
      .then(async (response) => {
        if (response.status === 429) {
          showOrderSubmitError(
            "Вы отправляете заказы слишком часто! Пожалуйста, подождите 1 минуту."
          );
          return null;
        }
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        if (!response.ok) {
          showOrderSubmitError(
            data?.error || "Не удалось оформить заказ. Попробуйте ещё раз."
          );
          return null;
        }
        return { response, data };
      })
      .then((result) => {
        if (!result) return;
        const { data } = result;
        if (data && data.success === true) {
          const orderId = data.order_id ? String(data.order_id) : "";

          window.CART = [];
          window.activePromoCode = "";
          window.activePromoDiscount = 0;
          const promoInput = document.getElementById("client-promo-input");
          const promoStatus = document.getElementById("promo-status-message");
          if (promoStatus) {
            promoStatus.style.display = "none";
            promoStatus.innerText = "";
          }
          if (promoInput) promoInput.value = "";
          document.getElementById("order-client-form")?.reset();
          hideAddressSuggestions();
          clearSelectedAddressCoords();
          clearCheckoutClientCoordsStorage();
          syncDeliveryAddressField();
          clearCheckoutLocalStorage();
          window.updateCartUI();
          refreshAllProductCardCounters();

          if (orderId) {
            beginOrderStatusFlowAfterSubmit(orderId, isDelivery, data);
          } else {
            alert("Заказ успешно оформлен!");
            window.closeOrderModal();
          }
          return;
        }

        if (data && data.success === false) {
          showOrderSubmitError(
            data.error ||
              "Доставка недоступна. Измените адрес или выберите «Самовывоз»."
          );
          return;
        }

        showOrderSubmitError("Не удалось оформить заказ. Попробуйте ещё раз.");
      })
      .catch((err) =>
        showOrderSubmitError("Ошибка сети: " + (err?.message || String(err)))
      );
  } catch (err) {
    alert("Ошибка отправки: " + (err && err.message ? err.message : String(err)));
  }
};

function initCartAndOrderUi() {
  syncDeliveryAddressField();
  initAddressAutocomplete();
  initAdminUnitTypeToggle();
  initWeightModalUi();
  bindCheckoutFormPersistence();
  document.getElementById("delivery-method")?.addEventListener("change", syncDeliveryAddressField);

  document.getElementById("cart-bar")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      window.openOrderModal();
    }
  });

  if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.MainButton.onClick(window.sendOrderToTelegram);
  }
}

window.editProductPrompt = window.openEditProductModal;

window.loadAdminStats = function () {
  const userId = tg.initDataUnsafe?.user?.id || window.ADMIN_USER_ID;
  if (!userId) {
    alert("Не удалось определить ID администратора");
    return;
  }

  const box = document.getElementById("admin-stats-output");
  if (box) {
    box.textContent = "Загрузка…";
  }

  fetch(`/api/admin/stats?user_id=${encodeURIComponent(String(userId))}`)
    .then((r) => r.json())
    .then((res) => {
      if (!box) return;
      if (!res.success || !res.stats) {
        box.textContent = "Ошибка загрузки аналитики";
        return;
      }

      const s = res.stats;
      const counts = s.counts || {};
      const tops = Array.isArray(s.top_products) ? s.top_products : [];
      const topsHtml = tops.length
        ? tops
            .map(
              ([name, qty]) =>
                `<li>${escapeHtml(String(name))} — ${escapeHtml(String(qty))} шт.</li>`
            )
            .join("")
        : "<li>Нет данных</li>";

      box.innerHTML = `
        <div class="admin-stats-card">
          <div class="admin-stats-grid">
            <div class="admin-stat-item">
              <span class="admin-stat-label">Выручка сегодня</span>
              <span class="admin-stat-value">${escapeHtml(String(s.revenue_today ?? 0))} ₴</span>
            </div>
            <div class="admin-stat-item">
              <span class="admin-stat-label">Выручка всего</span>
              <span class="admin-stat-value">${escapeHtml(String(s.revenue_total ?? 0))} ₴</span>
            </div>
          </div>
          <div class="admin-stats-counts">
            <div class="admin-count-chip">
              <strong>${escapeHtml(String(counts.processing ?? 0))}</strong>
              <span>В обработке</span>
            </div>
            <div class="admin-count-chip">
              <strong>${escapeHtml(String(counts.active ?? 0))}</strong>
              <span>В доставке</span>
            </div>
            <div class="admin-count-chip">
              <strong>${escapeHtml(String(counts.completed ?? 0))}</strong>
              <span>Выполнено</span>
            </div>
          </div>
          <div class="admin-stats-tops-block">
            <p class="admin-stats-tops-title">Топ товаров</p>
            <ul class="admin-stats-tops">${topsHtml}</ul>
          </div>
        </div>
      `;
    })
    .catch(() => {
      if (box) box.textContent = "Ошибка загрузки аналитики";
    });
};

window.sendBroadcast = function () {
  const text = document.getElementById("admin-broadcast-text")?.value?.trim() || "";
  if (!text) {
    alert("Введите текст рассылки");
    return;
  }

  const userId = tg.initDataUnsafe?.user?.id || window.ADMIN_USER_ID;
  if (!userId) {
    alert("Не удалось определить ID администратора");
    return;
  }

  if (!confirm("Запустить рассылку всем клиентам из базы заказов?")) {
    return;
  }

  fetch("/api/admin/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      text,
    }),
  })
    .then((r) => r.json())
    .then((res) => {
      if (res.success) {
        alert(`Рассылка отправлена: ${res.sent_to ?? 0} получателей`);
      } else {
        alert(res.error || "Ошибка рассылки");
      }
    })
    .catch(() => alert("Ошибка рассылки"));
};

/** Кнопка «⚙️ Управление магазином» (#toggle-admin-mode-btn) в index.html */
window.toggleAdminMode = function () {
  if (!IS_ADMIN) return;

  window.ADMIN_MODE_ACTIVE = !window.ADMIN_MODE_ACTIVE;

  const productsGrid = document.getElementById("products-grid");
  if (productsGrid) {
    if (window.ADMIN_MODE_ACTIVE === true) {
      productsGrid.classList.add("admin-mode-active");
    } else {
      productsGrid.classList.remove("admin-mode-active");
    }
  }

  syncProductGridsAdminClass();
  syncAdminModeUi();
  refreshCatalogAfterServerSync({ forceSidebar: true });
};

/** @deprecated используйте window.toggleAdminMode */
window.toggleAdminPanel = window.toggleAdminMode;

/** Гарантирует, что витрина не скрыта вместе с админкой. */
function ensureCatalogLayoutVisible() {
  const main = document.querySelector(".main-layout");
  const side = document.getElementById("categories-sidebar");
  const content = document.getElementById("catalog-content");
  [main, side, content].forEach((el) => {
    if (!el) return;
    el.style.removeProperty("display");
    el.style.removeProperty("visibility");
  });
}

const DEFAULT_BANNER_SRC =
  "https://images.unsplash.com/photo-1603360946369-dc9bb6258143?auto=format&fit=crop&w=320&q=80";

let bannerPreviewObjectUrl = null;

function revokeBannerPreviewUrl() {
  if (bannerPreviewObjectUrl) {
    URL.revokeObjectURL(bannerPreviewObjectUrl);
    bannerPreviewObjectUrl = null;
  }
}

function showBannerPreviewFromFile(file) {
  const img = document.getElementById("main-banner");
  if (!img || !(file instanceof File)) return;
  revokeBannerPreviewUrl();
  bannerPreviewObjectUrl = URL.createObjectURL(file);
  img.src = bannerPreviewObjectUrl;
  bindBannerFadeIn(img);
}

function bindBannerFadeIn(img) {
  if (!img) return;
  const reveal = () => img.classList.add("is-visible");
  if (img.complete && img.naturalWidth > 0) {
    reveal();
    return;
  }
  img.classList.remove("is-visible");
  img.addEventListener("load", reveal, { once: true });
}

function setMainBannerSrc(path, forceCacheBust) {
  const img = document.getElementById("main-banner");
  if (!img) return;

  const trimmed = path != null ? String(path).trim() : "";
  if (!trimmed || trimmed.startsWith("blob:")) {
    if (!trimmed) {
      const current = String(img.getAttribute("src") || "").trim();
      if (current && !current.startsWith("blob:")) {
        return;
      }
      revokeBannerPreviewUrl();
      img.src = DEFAULT_BANNER_SRC;
    }
    return;
  }

  revokeBannerPreviewUrl();

  if (forceCacheBust || trimmed.startsWith("uploads/")) {
    const base = trimmed.split("?")[0];
    img.src = `${base}?t=${Date.now()}`;
    bindBannerFadeIn(img);
    return;
  }

  img.src = trimmed;
  bindBannerFadeIn(img);
}

function applyCachedBannerPath() {
  try {
    const path = localStorage.getItem(BANNER_LS_KEY);
    if (path && String(path).trim()) {
      setMainBannerSrc(path, false);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function initBanner(options = {}) {
  const force = options.force === true;
  if (bannerLoadDone && !force) {
    return;
  }

  applyCachedBannerPath();

  try {
    const res = await fetch("/api/get_banner");
    const data = await res.json().catch(() => ({}));
    const path = data.path || "";
    if (path) {
      setMainBannerSrc(path, false);
      try {
        localStorage.setItem(BANNER_LS_KEY, path);
      } catch {
        /* ignore */
      }
    }
    bannerLoadDone = true;
  } catch (e) {
    console.error("initBanner:", e);
    if (!String(document.getElementById("main-banner")?.getAttribute("src") || "").trim()) {
      setMainBannerSrc("", false);
    }
  }
}

window.uploadBanner = async function () {
  if (!IS_ADMIN) return;

  const file = document.getElementById("banner-input")?.files?.[0] ?? null;
  if (!file || !(file instanceof File)) {
    tg.showAlert("Выберите файл изображения баннера.");
    return;
  }

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram или войдите как пользователь.");
    return;
  }

  const uploadBtn = document.querySelector("#tab-banner button");
  if (uploadBtn?.disabled) return;

  const prevBtnText = uploadBtn ? uploadBtn.textContent : "Обновить баннер";

  showBannerPreviewFromFile(file);

  if (uploadBtn) {
    uploadBtn.disabled = true;
    uploadBtn.textContent = "Сохранение...";
  }

  const fd = new FormData();
  fd.append("user_id", userId);
  fd.append("banner", file, file.name);

  try {
    const res = await fetch("/api/upload_banner", { method: "POST", body: fd });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success !== true) {
      revokeBannerPreviewUrl();
      await initBanner({ force: true });
      tg.showAlert(data.error || "Не удалось обновить баннер.");
      return;
    }

    const bannerInput = document.getElementById("banner-input");
    if (bannerInput) bannerInput.value = "";

    setMainBannerSrc(data.path || "uploads/banner.webp", true);
    tg.HapticFeedback?.impactOccurred?.("light");
    tg.showAlert("Баннер обновлён!");
  } catch (e) {
    console.error(e);
    revokeBannerPreviewUrl();
    await initBanner({ force: true });
    tg.showAlert("Ошибка сети при загрузке баннера.");
  } finally {
    if (uploadBtn) {
      uploadBtn.disabled = false;
      uploadBtn.textContent = prevBtnText;
    }
  }
};

window.switchAdminTab = function (tabId, triggerEl) {
  if (!IS_ADMIN) return;

  const contents = document.querySelectorAll(".admin-tab-content");
  contents.forEach((content) => {
    content.style.display = "none";
  });

  const buttons = document.querySelectorAll(".admin-tab-btn");
  buttons.forEach((btn) => btn.classList.remove("active"));

  const activeContent = document.getElementById(tabId);
  if (activeContent) activeContent.style.display = "block";

  let clickedBtn = triggerEl;
  if (
    !clickedBtn &&
    typeof event !== "undefined" &&
    event &&
    event.currentTarget
  ) {
    clickedBtn = event.currentTarget;
  }
  if (!clickedBtn) {
    clickedBtn = document.querySelector(
      `.admin-tab-btn[data-admin-main-tab="${tabId}"]`
    );
  }
  if (clickedBtn) clickedBtn.classList.add("active");

  if (tabId === "tab-stats" && typeof window.loadAdminStats === "function") {
    window.loadAdminStats();
  }

  if (tabId === "tab-couriers") {
    loadCouriersList();
  }

  if (tabId === "tab-banner") {
    initMapBannerAdminInput();
    window.loadAdminMapBanner?.();
  }
  if (tabId === "tab-promocodes") {
    window.loadAdminPromocodes();
  }
};

function switchAdminCatalogTab(tab) {
  if (!isAdminEditMode()) return;
  document
    .querySelectorAll("#tab-products .admin-tab")
    .forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.adminTab === tab);
    });
  document.querySelectorAll("#tab-products .admin-tab-panel").forEach((panel) => {
    const show =
      (tab === "category" && panel.id === "admin-tab-category") ||
      (tab === "product" && panel.id === "admin-tab-product");
    panel.classList.toggle("is-active", show);
  });
}

/** Массив [{ tg_id, name, phone }] или legacy-объект { [id]: { name, phone } }. */
function normalizeCouriersPayload(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const tgId = String(item.tg_id ?? item.id ?? "").trim();
        if (!tgId) return null;
        return {
          tg_id: tgId,
          name: item.name != null ? String(item.name) : tgId,
          phone: item.phone != null ? String(item.phone) : "",
        };
      })
      .filter(Boolean);
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .map(([id, info]) => {
        const tgId = String(id).trim();
        if (!tgId) return null;
        return {
          tg_id: tgId,
          name: info && info.name != null ? String(info.name) : tgId,
          phone: info && info.phone != null ? String(info.phone) : "",
        };
      })
      .filter(Boolean);
  }
  return [];
}

function renderCouriersList(couriers) {
  const listEl = document.getElementById("admin-couriers-list");
  if (!listEl) return;

  const entries = normalizeCouriersPayload(couriers);
  if (!entries.length) {
    listEl.innerHTML = '<p class="couriers-empty">Курьеры не добавлены.</p>';
    return;
  }

  listEl.innerHTML = entries
    .map(({ tg_id, name }) => {
      const idEsc = jsIdForOnclickSingleQuotes(tg_id);
      return `
        <div class="courier-list-item">
          <div class="courier-list-info">
            <strong>${escapeHtml(name)}</strong>
            <span>ID: ${escapeHtml(String(tg_id))}</span>
          </div>
          <button type="button" class="courier-delete-btn" onclick="window.deleteCourier('${idEsc}')">Удалить</button>
        </div>`;
    })
    .join("");
}

async function loadCouriersList() {
  if (!IS_ADMIN) return;

  const listEl = document.getElementById("admin-couriers-list");
  if (listEl) {
    listEl.innerHTML = '<p class="couriers-empty">Загрузка...</p>';
  }

  const userId = getTelegramUserId();
  if (!userId) {
    if (listEl) {
      listEl.innerHTML =
        '<p class="couriers-empty">Откройте приложение в Telegram.</p>';
    }
    return;
  }

  try {
    const res = await fetch(
      `/api/admin/couriers?user_id=${encodeURIComponent(userId)}`
    );
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      if (listEl) {
        listEl.innerHTML = `<p class="couriers-empty">${escapeHtml(data.error || "Не удалось загрузить список.")}</p>`;
      }
      return;
    }

    renderCouriersList(data.couriers);
  } catch (e) {
    console.error(e);
    if (listEl) {
      listEl.innerHTML = '<p class="couriers-empty">Ошибка сети.</p>';
    }
  }
}

window.addCourier = async function () {
  if (!IS_ADMIN) return;

  const name = document.getElementById("admin-courier-name")?.value?.trim() ?? "";
  const courierId =
    document.getElementById("admin-courier-id")?.value?.trim() ?? "";

  if (!name) {
    tg.showAlert("Укажите имя курьера.");
    return;
  }
  if (!courierId || !/^\d+$/.test(courierId)) {
    tg.showAlert("Укажите корректный Telegram ID (только цифры).");
    return;
  }

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram.");
    return;
  }

  try {
    const res = await fetch("/api/admin/add_courier", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ user_id: userId, id: courierId, name }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      tg.showAlert(data.error || "Не удалось добавить курьера.");
      return;
    }

    document.getElementById("admin-courier-form")?.reset();
    await loadCouriersList();
    tg.HapticFeedback?.impactOccurred?.("light");
    tg.showAlert("Курьер добавлен.");
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети.");
  }
};

window.deleteCourier = async function (courierId) {
  if (!IS_ADMIN) return;
  if (!confirm("Удалить этого курьера?")) return;

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram.");
    return;
  }

  try {
    const res = await fetch("/api/admin/delete_courier", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ user_id: userId, id: String(courierId) }),
    });
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      tg.showAlert(data.error || "Не удалось удалить курьера.");
      return;
    }

    await loadCouriersList();
    tg.HapticFeedback?.impactOccurred?.("light");
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети.");
  }
};

const ADMIN_RECEIPTS_PW_KEY = "halal_admin_receipts_password";
let _adminReceiptsReturnTab = "tab-stats";

function getAdminReceiptsPassword() {
  return sessionStorage.getItem(ADMIN_RECEIPTS_PW_KEY) || "";
}

function showAdminReceiptsWorkspace() {
  document.querySelectorAll(".admin-tab-content").forEach((el) => {
    if (el.id !== "tab-receipts") {
      el.style.display = "none";
    }
  });
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  const receiptsTab = document.getElementById("tab-receipts");
  if (receiptsTab) receiptsTab.style.display = "block";
}

window.openAdminReceiptsPasswordModal = function openAdminReceiptsPasswordModal() {
  if (!IS_ADMIN) return;

  const activeBtn = document.querySelector(".admin-tab-btn.active");
  if (activeBtn?.dataset?.adminMainTab) {
    _adminReceiptsReturnTab = activeBtn.dataset.adminMainTab;
  }

  const modal = document.getElementById("admin-receipts-password-modal");
  const input = document.getElementById("admin-receipts-password-modal-input");
  if (!modal) return;

  modal.classList.add("is-open");
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 50);
  }
};

window.closeAdminReceiptsPasswordModal = function closeAdminReceiptsPasswordModal() {
  const modal = document.getElementById("admin-receipts-password-modal");
  if (modal) modal.classList.remove("is-open");
};

window.submitAdminReceiptsPassword = async function submitAdminReceiptsPassword() {
  if (!IS_ADMIN) return;

  const password =
    document
      .getElementById("admin-receipts-password-modal-input")
      ?.value?.trim() ?? "";
  if (!password) {
    tg.showAlert("Введите пароль.");
    return;
  }

  const listEl = document.getElementById("admin-receipts-list");
  if (listEl) listEl.innerHTML = '<p class="receipts-empty">Загрузка...</p>';

  try {
    const res = await fetch("/api/admin/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ password }),
    });
    const data = await parseJsonResponse(res);

    if (res.status === 403 || data.status === "error") {
      tg.showAlert("Доступ запрещен: неверный пароль");
      if (listEl) listEl.innerHTML = "";
      return;
    }

    sessionStorage.setItem(ADMIN_RECEIPTS_PW_KEY, password);
    window.closeAdminReceiptsPasswordModal();
    showAdminReceiptsWorkspace();
    renderAdminReceiptsList(data.receipts, { view: "active" });
  } catch (err) {
    console.error(err);
    tg.showAlert("Не удалось загрузить чеки.");
    if (listEl) listEl.innerHTML = "";
  }
};

window.exitAdminReceiptsView = function exitAdminReceiptsView() {
  sessionStorage.removeItem(ADMIN_RECEIPTS_PW_KEY);
  const listEl = document.getElementById("admin-receipts-list");
  if (listEl) listEl.innerHTML = "";
  const receiptsTab = document.getElementById("tab-receipts");
  if (receiptsTab) receiptsTab.style.display = "none";
  window.switchAdminTab(_adminReceiptsReturnTab || "tab-stats");
};

function isOrderLineWeightItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.is_weight_item === true) return true;
  if (item.is_weight_item === false) return false;
  return normalizeUnitType(item.unit_type) === "weight";
}

function orderLineQuantityGrams(item) {
  const raw =
    item?.quantity ?? item?.count ?? item?.qty ?? item?.ordered_quantity ?? 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  return n;
}

function gramsToKgInputValue(grams) {
  const g = Number(grams);
  if (Number.isNaN(g) || g <= 0) return "0";
  return (g / 1000).toFixed(3);
}

function itemPricePerKg(item) {
  if (item?.price_per_kg != null) {
    const p = Number(item.price_per_kg);
    if (Number.isFinite(p)) return p;
  }
  const per100 = Number(item?.price);
  return Number.isFinite(per100) ? per100 * 10 : 0;
}

const ADMIN_CANCELLED_ORDER_STATUSES = new Set([
  "cancelled",
  "canceled",
  "deleted",
]);

function isAdminActiveReceipt(order) {
  const status = String(order?.status || "").toLowerCase();
  return !ADMIN_CANCELLED_ORDER_STATUSES.has(status);
}

function filterAdminActiveReceipts(receipts) {
  return (Array.isArray(receipts) ? receipts : []).filter(isAdminActiveReceipt);
}

function adminOrderStatusLabel(status) {
  const s = String(status || "").toLowerCase();
  const map = {
    pending_weight_verification: "⏳ Ожидает взвешивания",
    awaiting_payment: "💳 Ожидает оплаты",
    processing: "📦 В обработке",
    active: "🛵 Курьер назначен",
    delivery: "🚗 В доставке",
    delivering: "🚗 В доставке",
    paid: "💰 Оплачен",
    completed: "✅ Завершён",
    cancelled: "❌ Отменён",
    canceled: "❌ Отменён",
    deleted: "🗑️ Удалён",
  };
  return map[s] || escapeHtml(status || "—");
}

function findAdminOrderCardElement(orderId) {
  const id = String(orderId ?? "").trim();
  if (!id) return null;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    return document.querySelector(
      `.admin-order-card[data-order-id="${escaped}"]`
    );
  } catch {
    return null;
  }
}

function removeAdminOrderCardFromDom(orderId) {
  const card = findAdminOrderCardElement(orderId);
  if (!card) return false;
  card.remove();
  const listEl = document.getElementById("admin-receipts-list");
  if (listEl && !listEl.querySelector(".admin-order-card")) {
    listEl.innerHTML = '<p class="receipts-empty">Активных чеков нет.</p>';
  }
  return true;
}

function renderAdminOrderLineItems(cart) {
  const lines = Array.isArray(cart) ? cart : [];
  if (!lines.length) {
    return '<li class="admin-order-item-line">—</li>';
  }

  return lines
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const name = escapeHtml(String(item.name || item.title || "Товар"));
      const itemId = escapeHtml(String(item.id ?? ""));

      if (!isOrderLineWeightItem(item)) {
        const qty = item.quantity ?? item.qty ?? item.count ?? 1;
        return `<li class="admin-order-item-line">${name} × ${escapeHtml(String(qty))}</li>`;
      }

      const gramsOrdered = orderLineQuantityGrams(item);
      const orderedKg = gramsToKgInputValue(gramsOrdered);
      const actualKgRaw =
        item.actual_quantity != null
          ? Number(item.actual_quantity)
          : Number(orderedKg);
      const inputValue = Number.isFinite(actualKgRaw)
        ? gramsToKgInputValue(
            item.actual_quantity != null
              ? actualKgRaw * 1000
              : gramsOrdered
          )
        : orderedKg;
      const pricePerKg = itemPricePerKg(item);

      return `
        <li>
          <div class="weight-edit-row" data-item-id="${itemId}">
            <span>${name} (Заказано: ${escapeHtml(orderedKg)} кг)</span>
            <input
              type="number"
              step="0.001"
              min="0.001"
              class="admin-weight-input"
              value="${escapeHtml(String(inputValue))}"
              data-price="${escapeHtml(String(pricePerKg))}"
              aria-label="Фактический вес ${name}"
            />
            кг
          </div>
        </li>
      `;
    })
    .join("");
}

function renderAdminOrders(orders) {
  const listEl = document.getElementById("admin-receipts-list");
  if (!listEl) return;

  const items = Array.isArray(orders) ? orders : [];
  if (!items.length) {
    listEl.innerHTML = '<p class="receipts-empty">Чеков пока нет.</p>';
    return;
  }

  listEl.innerHTML = items
    .map((order) => {
      const id = String(order.id ?? order.order_id ?? "");
      const idEsc = escapeHtml(id);
      const total = Number(order.total ?? order.total_price ?? 0);
      const totalStr = Number.isFinite(total) ? `${total} ₴` : "—";
      const created = escapeHtml(order.created_at || order.date_short || "—");
      const status = String(order.status || "").toLowerCase();
      const statusClass =
        status === "pending_weight_verification"
          ? "receipt-status-pending-weight"
          : "";
      const statusLabel = adminOrderStatusLabel(status);
      const cart = order.items || order.cart || [];
      const itemsHtml = renderAdminOrderLineItems(cart);
      const approveBtn =
        status === "pending_weight_verification"
          ? `<button type="button" class="btn-approve-weight" data-order-id="${idEsc}">⚖️ Утвердить вес и отправить клиенту</button>`
          : "";

      return `
        <article class="receipt-list-item admin-order-card" data-order-id="${idEsc}">
          <div class="admin-order-card-header">
            <div class="receipt-list-info">
              <strong>№ заказа: ${idEsc}</strong>
              <span class="receipt-meta">Дата: ${created}</span>
              <span class="receipt-meta">Сумма: ${totalStr}</span>
              <span class="receipt-meta ${statusClass}">Статус: ${statusLabel}</span>
              <ul class="admin-order-items">${itemsHtml}</ul>
            </div>
            <button
              type="button"
              class="receipt-delete-btn"
              onclick="window.deleteAdminReceipt('${idEsc}')"
            >
              ❌ Удалить
            </button>
          </div>
          ${approveBtn}
        </article>
      `;
    })
    .join("");

  listEl.querySelectorAll(".btn-approve-weight").forEach((btn) => {
    btn.addEventListener("click", () => {
      const orderId = btn.getAttribute("data-order-id");
      if (orderId) window.sendUpdatedOrderToClient(orderId);
    });
  });
}

function renderAdminReceiptsList(receipts, options = {}) {
  const all = Array.isArray(receipts) ? receipts : [];
  window._adminReceiptsCache = all;
  const view = options.view === "history" ? "history" : "active";
  const visible =
    view === "history"
      ? all.filter((o) => !isAdminActiveReceipt(o))
      : filterAdminActiveReceipts(all);
  renderAdminOrders(visible);
}

window.sendUpdatedOrderToClient = async function sendUpdatedOrderToClient(
  orderId
) {
  if (!IS_ADMIN) return;
  const id = String(orderId || "").trim();
  if (!id) return;

  const card = document.querySelector(
    `.admin-order-card[data-order-id="${CSS.escape(id)}"]`
  );
  if (!card) {
    tg.showAlert?.("Карточка заказа не найдена.");
    return;
  }

  const inputs = card.querySelectorAll(".admin-weight-input");
  const updatedItems = [];

  inputs.forEach((input) => {
    const row = input.closest(".weight-edit-row");
    if (!row) return;
    const itemId = row.getAttribute("data-item-id");
    const kg = parseFloat(String(input.value).replace(",", "."));
    if (!itemId || Number.isNaN(kg) || kg <= 0) return;
    updatedItems.push({
      item_id: itemId,
      id: itemId,
      actual_quantity: kg,
      quantity: Math.round(kg * 1000),
    });
  });

  if (!updatedItems.length) {
    tg.showAlert?.("Укажите фактический вес для весовых товаров.");
    return;
  }

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert?.("Откройте приложение в Telegram.");
    return;
  }

  try {
    const res = await fetch(
      `/api/admin/orders/${encodeURIComponent(id)}/update_weights`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ user_id: String(userId), items: updatedItems }),
      }
    );
    const data = await parseJsonResponse(res);

    if (!res.ok || data.success === false) {
      tg.showAlert?.(data.error || "Не удалось обновить веса.");
      return;
    }

    tg.HapticFeedback?.notificationOccurred?.("success");
    const updatedTotal = data.new_total_price ?? data.total_price;
    tg.showAlert?.(
      `Вес утверждён. Новая сумма: ${formatPriceUi(updatedTotal)} ₴`
    );
    await window.loadAdminReceipts(true);
  } catch (err) {
    console.error(err);
    tg.showAlert?.("Ошибка сети.");
  }
};

window.loadAdminReceipts = async function loadAdminReceipts(forceReload) {
  if (!IS_ADMIN) return;

  const password = getAdminReceiptsPassword();
  if (!password) {
    window.openAdminReceiptsPasswordModal();
    return;
  }

  const listEl = document.getElementById("admin-receipts-list");
  if (listEl && forceReload) {
    listEl.innerHTML = '<p class="receipts-empty">Загрузка...</p>';
  }

  try {
    const res = await fetch("/api/admin/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ password }),
    });
    const data = await parseJsonResponse(res);

    if (res.status === 403 || data.status === "error") {
      sessionStorage.removeItem(ADMIN_RECEIPTS_PW_KEY);
      tg.showAlert("Доступ запрещен: неверный пароль");
      window.openAdminReceiptsPasswordModal();
      return;
    }

    showAdminReceiptsWorkspace();
    renderAdminReceiptsList(data.receipts, { view: "active" });
  } catch (err) {
    console.error(err);
    if (listEl) {
      listEl.innerHTML = '<p class="receipts-empty">Ошибка сети.</p>';
    }
    tg.showAlert("Не удалось загрузить чеки.");
  }
};

window.deleteAdminReceipt = async function deleteAdminReceipt(receiptId) {
  if (!IS_ADMIN) return;
  const id = String(receiptId || "").trim();
  if (!id) return;
  if (!confirm(`Удалить чек №${id}?`)) {
    return;
  }
  const password = getAdminReceiptsPassword();
  if (!password) {
    window.openAdminReceiptsPasswordModal();
    return;
  }
  try {
    const res = await fetch("/api/admin/delete_receipt", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ password, id, order_id: id, receipt_id: id }),
    });
    const data = await parseJsonResponse(res);
    if (res.status === 403 || data.status === "error") {
      tg.showAlert(data.message || data.error || "Доступ запрещен: неверный пароль");
      if (res.status === 403) {
        sessionStorage.removeItem(ADMIN_RECEIPTS_PW_KEY);
      }
      return;
    }
    const cancelled =
      res.ok &&
      (data.status === "success" ||
        String(data.new_status || "").toLowerCase() === "cancelled");
    if (!cancelled) {
      tg.showAlert(data.message || data.error || "Не удалось удалить чек.");
      return;
    }

    const activeOrderId = getActiveOrderId();
    if (activeOrderId === id) {
      clearActiveOrderSnapshot();
      setActiveOrderId(null);
      stopOrderStatusPolling();
      window._activeOrderTracking = null;
      window._orderStatusUiPhase = null;

      if (orderModalIsOpen()) {
        window.closeOrderModal();
      }
      hideActiveOrderFloatingButton();

      if (typeof tg?.showAlert === "function") {
        tg.showAlert("Ваш заказ был отменён администратором.");
      }
    }

    if (Array.isArray(window._adminReceiptsCache)) {
      window._adminReceiptsCache = window._adminReceiptsCache.map((order) => {
        const oid = String(order.id ?? order.order_id ?? "");
        if (oid !== id) return order;
        return { ...order, status: "cancelled" };
      });
    }
    removeAdminOrderCardFromDom(id);
    tg.HapticFeedback?.impactOccurred?.("light");
    tg.showAlert?.("Чек отменён. Клиент уведомлён.");
    renderAdminReceiptsList(window._adminReceiptsCache || [], { view: "active" });

    await checkActiveUserOrder();
  } catch (err) {
    console.error(err);
    tg.showAlert("Ошибка сети.");
  }
};

document.addEventListener("keydown", (e) => {
  const modal = document.getElementById("admin-receipts-password-modal");
  if (!modal?.classList.contains("is-open")) return;
  if (e.key === "Escape") window.closeAdminReceiptsPasswordModal();
  if (e.key === "Enter") window.submitAdminReceiptsPassword();
});

function clearAdminFileInputs() {
  const c = document.getElementById("category-file");
  const p = document.getElementById("product-file");
  if (c) c.value = "";
  if (p) p.value = "";
}

/** Перезагрузка каталога с сервера; forceRender — только когда нужна полная перерисовка DOM. */
async function reloadStorefrontFromServer(options = {}) {
  return loadCatalogFromServer({
    forceRender: options.forceRender === true,
    forceSidebar: options.forceSidebar === true,
  });
}

async function refreshCatalogAfterSuccess(options = {}) {
  await syncStorefrontAfterAdminSave(options);
}

async function addCategory() {
  if (!IS_ADMIN) return;

  await runAdminCatalogSaveAction({
    getPending: () => adminCategorySavePending,
    setPending: (v) => {
      adminCategorySavePending = v;
    },
    buttonSelector: "#admin-add-category-btn",
    busyLabel: "Сохранение…",
    action: async () => {
      const title =
        document.getElementById("admin-new-category-title")?.value?.trim() ?? "";
      const file = document.getElementById("category-file")?.files?.[0] ?? null;

      if (!title) {
        tg.showAlert("Укажите название категории.");
        return;
      }
      if (!file || !(file instanceof File)) {
        tg.showAlert("Выберите файл изображения категории.");
        return;
      }

      const userId = getTelegramUserId();
      if (!userId) {
        tg.showAlert("Откройте приложение в Telegram или войдите как пользователь.");
        return;
      }

      const optimisticId = makeOptimisticCategoryId();
      const previewUrl = URL.createObjectURL(file);
      const rollback = applyOptimisticCategoryEntry({
        id: optimisticId,
        title,
        image: previewUrl,
      });

      renderStorefrontOptimistic();
      document.getElementById("admin-category-form")?.reset();
      clearAdminFileInputs();

      const fd = new FormData();
      fd.append("user_id", userId);
      fd.append("operation", OP_ADD_CATEGORY);
      fd.append("category_title", title);
      fd.append("image", file, file.name);

      try {
        const result = await enqueueSaveProductsRequest(() =>
          fetch("/api/save_products", {
            method: "POST",
            body: fd,
          })
        );

        if (!result.ok) {
          rollback();
          renderStorefrontOptimistic();
          URL.revokeObjectURL(previewUrl);
          if (!result.rateLimited) {
            offerAdminSaveRetry(
              result.data?.error || "Не удалось сохранить категорию на сервере."
            );
          }
          scheduleNonCriticalTask(() =>
            reloadStorefrontFromServer({ forceSidebar: true, forceRender: true })
          );
          return;
        }

        URL.revokeObjectURL(previewUrl);
        scheduleNonCriticalTask(() =>
          syncStorefrontAfterAdminSave({
            resetCategoryForm: false,
            forceRender: true,
          })
        );
        tg.HapticFeedback?.impactOccurred?.("light");
      } catch (e) {
        console.error(e);
        rollback();
        renderStorefrontOptimistic();
        URL.revokeObjectURL(previewUrl);
        offerAdminSaveRetry("Ошибка сети при сохранении категории.");
        scheduleNonCriticalTask(() =>
          reloadStorefrontFromServer({ forceSidebar: true, forceRender: true })
        );
      }
    },
  });
}

async function addNewProduct() {
  if (!IS_ADMIN) return;

  await runAdminCatalogSaveAction({
    getPending: () => adminProductSavePending,
    setPending: (v) => {
      adminProductSavePending = v;
    },
    buttonSelector: "#admin-add-product-btn",
    busyLabel: "Сохранение…",
    action: async () => {
      ensureStoreShape();
      const categoryId = document.getElementById("admin-category")?.value;
      const name = document.getElementById("admin-name")?.value?.trim();
      const priceRaw = document.getElementById("admin-price")?.value;
      const file = document.getElementById("product-file")?.files?.[0] ?? null;

      if (!name) {
        tg.showAlert("Укажите название товара.");
        return;
      }

      const price = Number(priceRaw);
      if (Number.isNaN(price) || price < 0) {
        tg.showAlert("Укажите корректную цену.");
        return;
      }

      if (
        !categoryId ||
        !window.STORE_DATA.categories.some((c) => String(c.id) === String(categoryId))
      ) {
        tg.showAlert("Выберите категорию.");
        return;
      }

      if (!file || !(file instanceof File)) {
        tg.showAlert("Выберите файл изображения товара.");
        return;
      }

      const userId = getTelegramUserId();
      if (!userId) {
        tg.showAlert("Откройте приложение в Telegram или войдите как пользователь.");
        return;
      }

      const unitType = normalizeUnitType(window.currentAdminUnitType || "pcs");
      const optimisticId = makeOptimisticProductId();
      const previewUrl = URL.createObjectURL(file);
      const rollback = applyOptimisticProductEntry({
        id: optimisticId,
        categoryId: String(categoryId),
        name,
        price,
        unitType,
        image: previewUrl,
      });

      renderStorefrontOptimistic();
      const addForm = document.getElementById("admin-product-form");
      addForm?.reset();
      const pcsBtn = addForm?.querySelector('[data-unit-type="pcs"]');
      if (pcsBtn) window.setAdminUnitType("pcs", pcsBtn);
      clearAdminFileInputs();

      const fd = new FormData();
      fd.append("user_id", userId);
      fd.append("operation", OP_ADD_PRODUCT);
      fd.append("category_id", String(categoryId));
      fd.append("name", name);
      fd.append("price", String(price));
      fd.append("unit_type", unitType);
      fd.append("image", file, file.name);

      try {
        const result = await enqueueSaveProductsRequest(() =>
          fetch("/api/save_products", {
            method: "POST",
            body: fd,
          })
        );

        if (!result.ok) {
          rollback();
          renderStorefrontOptimistic();
          URL.revokeObjectURL(previewUrl);
          if (!result.rateLimited) {
            offerAdminSaveRetry(
              result.data?.error || "Не удалось сохранить товар на сервере."
            );
          }
          scheduleNonCriticalTask(() =>
            reloadStorefrontFromServer({ forceSidebar: true, forceRender: true })
          );
          return;
        }

        URL.revokeObjectURL(previewUrl);
        scheduleNonCriticalTask(() =>
          syncStorefrontAfterAdminSave({
            resetProductForm: false,
            forceRender: true,
          })
        );
        tg.HapticFeedback?.impactOccurred?.("light");
      } catch (e) {
        console.error(e);
        rollback();
        renderStorefrontOptimistic();
        URL.revokeObjectURL(previewUrl);
        offerAdminSaveRetry("Ошибка сети при сохранении товара.");
        scheduleNonCriticalTask(() =>
          reloadStorefrontFromServer({ forceSidebar: true, forceRender: true })
        );
      }
    },
  });
}

/** Только админка (удаление категории и т.п.). Корзина сюда не пишет — без /api/save_products. */
async function saveProductsToServer() {
  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram для сохранения.");
    await reloadStorefrontFromServer({ forceSidebar: true, forceRender: true });
    return;
  }

  ensureStoreShape();

  const bodyObj = {
    user_id: userId,
    categories: window.STORE_DATA.categories,
    products: window.STORE_DATA.products,
  };

  try {
    const result = await enqueueSaveProductsRequest(() =>
      fetch("/api/save_products", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(bodyObj),
      })
    );

    if (!result.ok) {
      if (!result.rateLimited) {
        tg.showAlert(result.data?.error || "Не удалось сохранить данные.");
      }
      await reloadStorefrontFromServer({ forceSidebar: true, forceRender: true });
      return;
    }

    await refreshCatalogAfterSuccess({ forceRender: true });
  } catch (e) {
    console.error(e);
    tg.showAlert("Ошибка сети при сохранении.");
    await reloadStorefrontFromServer({ forceSidebar: true, forceRender: true });
  }
}

function syncAdminUiAfterTelegramReady() {
  showAdminTriggerImmediately();
  ensureCatalogLayoutVisible();
}

/** Магазин: ул. Ламаная, 2, Днепр (fallback; приоритет — API order_status) */
const SHOP_TRACK_LAT = 48.467505;
const SHOP_TRACK_LON = 35.052745;
const TRACKING_COORD_EPSILON = 1e-5;

function parseTrackingCoord(value) {
  if (value == null || value === "") return NaN;
  const normalized = String(value).trim().replace(",", ".");
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : NaN;
}

function parseTrackingRouteCoords(orderData) {
  const source = orderData || {};
  const shopLat = parseTrackingCoord(
    source.shop_lat ??
      source.shop_latitude ??
      source.latitude ??
      SHOP_TRACK_LAT
  );
  const shopLon = parseTrackingCoord(
    source.shop_lon ??
      source.shop_longitude ??
      source.longitude ??
      SHOP_TRACK_LON
  );
  const clientLat = parseTrackingCoord(
    source.client_lat ?? source.client_latitude ?? source.user_lat
  );
  const clientLon = parseTrackingCoord(
    source.client_lon ?? source.client_longitude ?? source.user_lon
  );
  return { shopLat, shopLon, clientLat, clientLon };
}

function trackingCoordsNearlyEqual(lat1, lon1, lat2, lon2) {
  return (
    Math.abs(lat1 - lat2) < TRACKING_COORD_EPSILON &&
    Math.abs(lon1 - lon2) < TRACKING_COORD_EPSILON
  );
}

function isValidTrackingClientCoords(clientLat, clientLon, shopLat, shopLon) {
  if (!Number.isFinite(clientLat) || !Number.isFinite(clientLon)) {
    return false;
  }
  if (clientLat === 0 && clientLon === 0) {
    return false;
  }
  if (
    Number.isFinite(shopLat) &&
    Number.isFinite(shopLon) &&
    trackingCoordsNearlyEqual(clientLat, clientLon, shopLat, shopLon)
  ) {
    return false;
  }
  return true;
}

async function resolveClientCoordsForTracking(orderData, orderId) {
  let { shopLat, shopLon, clientLat, clientLon } =
    parseTrackingRouteCoords(orderData);

  if (!Number.isFinite(shopLat) || !Number.isFinite(shopLon)) {
    shopLat = SHOP_TRACK_LAT;
    shopLon = SHOP_TRACK_LON;
  }

  if (isValidTrackingClientCoords(clientLat, clientLon, shopLat, shopLon)) {
    return { shopLat, shopLon, clientLat, clientLon, hasClient: true };
  }

  console.error("Координаты клиента не заданы или дублируют магазин!");

  if (orderId) {
    const fresh = await fetchOrderStatusPayload(orderId);
    if (fresh) {
      const parsed = parseTrackingRouteCoords(fresh);
      shopLat = Number.isFinite(parsed.shopLat) ? parsed.shopLat : shopLat;
      shopLon = Number.isFinite(parsed.shopLon) ? parsed.shopLon : shopLon;
      clientLat = parsed.clientLat;
      clientLon = parsed.clientLon;
      if (isValidTrackingClientCoords(clientLat, clientLon, shopLat, shopLon)) {
        return { shopLat, shopLon, clientLat, clientLon, hasClient: true };
      }
    }
  }

  const address = String(
    orderData?.address || orderData?.delivery_address || ""
  ).trim();
  if (address) {
    console.warn(
      "Повторное получение координат клиента по адресу заказа:",
      address
    );
  }

  return {
    shopLat,
    shopLon,
    clientLat: NaN,
    clientLon: NaN,
    hasClient: false,
  };
}

function applyRouteCoordsFromApiPayload(tracking, data) {
  if (!tracking || !data) return;
  const { shopLat, shopLon, clientLat, clientLon } = parseTrackingRouteCoords(data);
  if (Number.isFinite(shopLat) && Number.isFinite(shopLon)) {
    tracking.shopLat = shopLat;
    tracking.shopLon = shopLon;
  }
  const originLat = Number.isFinite(shopLat) ? shopLat : SHOP_TRACK_LAT;
  const originLon = Number.isFinite(shopLon) ? shopLon : SHOP_TRACK_LON;
  if (isValidTrackingClientCoords(clientLat, clientLon, originLat, originLon)) {
    tracking.clientLat = clientLat;
    tracking.clientLon = clientLon;
  } else {
    tracking.clientLat = null;
    tracking.clientLon = null;
  }
}

const TRACKING_VIDEO_EXT_RE = /\.(mp4|mov|webm)$/i;
let _orderTrackingMediaKey = null;
let trackingOrderCompletionPollInterval = null;

function normalizeTrackingMediaUrl(url) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isTrackingMediaVideoUrl(url) {
  const path = String(url || "").split("?")[0].toLowerCase();
  return TRACKING_VIDEO_EXT_RE.test(path);
}

function isTrackingMediaVideo(payloadOrUrl, mediaType) {
  if (mediaType === "video") return true;
  if (mediaType === "image") return false;
  if (payloadOrUrl && typeof payloadOrUrl === "object") {
    if (payloadOrUrl.media_type === "video") return true;
    if (payloadOrUrl.media_type === "image") return false;
    return isTrackingMediaVideoUrl(
      payloadOrUrl.media_url || payloadOrUrl.media_filename || ""
    );
  }
  return isTrackingMediaVideoUrl(payloadOrUrl);
}

function pickTrackingMediaUrl(source) {
  if (!source) return "";
  if (typeof source === "string") return source;
  return source.media_url || "";
}

function pickOrderTrackingMediaSource(orderOrData) {
  if (!orderOrData) return null;

  const media = orderOrData.media;
  const banner = orderOrData.banner;

  if (media && typeof media === "object") return media;
  if (banner && typeof banner === "object") return banner;

  const url =
    (typeof media === "string" && media.trim()) ||
    (typeof banner === "string" && banner.trim()) ||
    String(orderOrData.media_url || "").trim();

  if (!url) return null;

  return {
    media_url: url,
    media_type: orderOrData.media_type || "",
    media_filename: orderOrData.media_filename || "",
  };
}

function hideOrderTrackingBanner() {
  const container = document.getElementById("tracking-media-container");
  if (!container) return;
  container.hidden = true;
  container.setAttribute("aria-hidden", "true");
  container.innerHTML = "";
}

function renderOrderTrackingBanner(orderOrData) {
  const container = document.getElementById("tracking-media-container");
  if (!container) return;

  const source = pickOrderTrackingMediaSource(orderOrData);
  const url = normalizeTrackingMediaUrl(pickTrackingMediaUrl(source));

  if (!url) {
    hideOrderTrackingBanner();
    if (window.mapInstance) {
      window.mapInstance.invalidateSize();
    }
    return;
  }

  const mediaType = source?.media_type || orderOrData?.media_type || "";
  const mediaFilename = source?.media_filename || orderOrData?.media_filename || "";
  const key = `${url}|${mediaType}|${mediaFilename}`;
  if (key === _orderTrackingMediaKey && !container.hidden) {
    return;
  }
  _orderTrackingMediaKey = key;

  container.hidden = false;
  container.setAttribute("aria-hidden", "false");

  if (isTrackingMediaVideo(source || orderOrData, mediaType)) {
    container.innerHTML = `<video src="${escapeAttr(url)}" autoplay loop muted playsinline></video>`;
    const video = container.querySelector("video");
    if (video) {
      video.play().catch(() => {});
    }
  } else {
    container.innerHTML = `<img src="${escapeAttr(url)}" alt="Статус доставки">`;
  }

  if (window.mapInstance) {
    requestAnimationFrame(() => {
      window.mapInstance?.invalidateSize();
    });
  }
}

async function fetchOrderStatusPayload(orderId, options = {}) {
  const oid = getTrackingOrderIdFromUrl(orderId);
  if (!oid) return null;

  const params = new URLSearchParams({ order_id: oid });
  const courierView =
    options.courierView === true || isCourierTrackingViewMode();
  if (courierView) {
    params.set("courier_view", "1");
    const courierId = options.courierId || getTelegramUserId();
    if (courierId) {
      params.set("courier_id", courierId);
    }
  }

  try {
    const res = await fetch(`/api/order_status?${params.toString()}`);
    const data = await parseJsonResponse(res);
    return data?.ok ? data : null;
  } catch (err) {
    console.error("fetchOrderStatusPayload:", err);
    return null;
  }
}

function stopTrackingOrderCompletionPolling() {
  if (trackingOrderCompletionPollInterval) {
    clearInterval(trackingOrderCompletionPollInterval);
    trackingOrderCompletionPollInterval = null;
  }
}

async function pollTrackingOrderCompletion(orderId) {
  const oid = getTrackingOrderIdFromUrl(orderId);
  if (!oid || window._trackingCompletionHandled) return;
  try {
    const data = await fetchOrderStatusPayload(oid, {
      courierView: isCourierTrackingViewMode(),
    });
    if (!data) return;
    renderOrderTrackingBanner(data);
    if (String(data.status || "").toLowerCase() === "completed") {
      handleTrackingOrderCompleted();
      return;
    }
    if (
      data.courier_lat != null &&
      data.courier_lon != null &&
      (window.trackingMap || window.mapInstance)
    ) {
      const { courier: courierIcon } = window.L
        ? getTrackingMapIcons(window.L)
        : { courier: null };
      window.updateCourierMarkerOnMap(data.courier_lat, data.courier_lon, {
        icon: courierIcon,
        animate: Boolean(window.courierMarker),
      });
    }
  } catch (err) {
    console.error("tracking order_status poll:", err);
  }
}

function startTrackingOrderCompletionPolling(orderId) {
  stopTrackingOrderCompletionPolling();
  const oid = getTrackingOrderIdFromUrl(orderId);
  if (!oid) return;
  pollTrackingOrderCompletion(oid);
  trackingOrderCompletionPollInterval = setInterval(
    () => pollTrackingOrderCompletion(oid),
    4000
  );
}

function renderAdminMapBannerPreview(mediaSource) {
  const preview = document.getElementById("map-banner-preview");
  if (!preview) return;

  const url = normalizeTrackingMediaUrl(pickTrackingMediaUrl(mediaSource));
  const mediaType =
    typeof mediaSource === "object" ? mediaSource.media_type || "" : "";
  const filename =
    typeof mediaSource === "object"
      ? mediaSource.media_filename || ""
      : url.split("/").pop() || "";

  if (!url) {
    preview.innerHTML = "Файл не загружен";
    return;
  }

  const fileLabel = filename
    ? `<span>Файл: ${escapeHtml(filename)}</span>`
    : "";

  if (isTrackingMediaVideo(mediaSource, mediaType)) {
    preview.innerHTML = `${fileLabel}<video src="${escapeAttr(url)}" muted playsinline controls style="max-width:100%;max-height:120px;border-radius:8px;margin-top:6px;"></video>`;
    return;
  }

  preview.innerHTML = `${fileLabel}<img src="${escapeAttr(url)}" alt="" style="max-width:100%;max-height:120px;border-radius:8px;margin-top:6px;">`;
}

window.loadAdminMapBanner = async function loadAdminMapBanner() {
  if (!IS_ADMIN) return;

  const userId = getTelegramUserId();
  if (!userId) return;

  try {
    const res = await fetch(
      `/api/admin/map_banner?user_id=${encodeURIComponent(userId)}`
    );
    const data = await parseJsonResponse(res);
    if (!data?.success) return;
    renderAdminMapBannerPreview(data);
  } catch (err) {
    console.error("loadAdminMapBanner:", err);
  }
};

window.uploadMapBanner = async function uploadMapBanner() {
  if (!IS_ADMIN) return;

  const input = document.getElementById("map-banner-input");
  const file = input?.files?.[0];
  if (!file) {
    tg.showAlert("Выберите фото или видео для баннера над картой.");
    return;
  }

  const userId = getTelegramUserId();
  if (!userId) {
    tg.showAlert("Откройте приложение в Telegram.");
    return;
  }

  const preview = document.getElementById("map-banner-preview");
  if (preview) preview.textContent = "Загрузка...";

  const fd = new FormData();
  fd.append("user_id", userId);
  fd.append("media", file, file.name);

  try {
    const res = await fetch("/api/upload_map_banner", {
      method: "POST",
      body: fd,
    });
    const data = await parseJsonResponse(res);
    if (!res.ok || data.success !== true) {
      tg.showAlert(data.error || "Не удалось загрузить медиа.");
      await window.loadAdminMapBanner();
      return;
    }

    renderAdminMapBannerPreview(data);
    if (input) input.value = "";
    tg.HapticFeedback?.impactOccurred?.("light");
    tg.showAlert("Медиа-баннер для карт сохранён.");
  } catch (err) {
    console.error("uploadMapBanner:", err);
    tg.showAlert("Ошибка сети при загрузке медиа.");
    await window.loadAdminMapBanner();
  }
};

function initMapBannerAdminInput() {
  if (window._mapBannerAdminInputInit) return;
  window._mapBannerAdminInputInit = true;

  document.getElementById("map-banner-input")?.addEventListener("change", () => {
    const input = document.getElementById("map-banner-input");
    if (input?.files?.[0]) {
      window.uploadMapBanner();
    }
  });
}

function hideShopUiForTracking() {
  document.querySelector(".shop-admin-area")?.style.setProperty("display", "none");
  document.querySelector("main.app")?.style.setProperty("display", "none");
  const cartPanel = document.getElementById("cart-checkout-panel");
  if (cartPanel) cartPanel.style.setProperty("display", "none");
  const orderScreen = document.getElementById("order-screen");
  if (orderScreen) orderScreen.style.setProperty("display", "none");
}

function handleTrackingOrderCompleted() {
  if (window._trackingCompletionHandled) return;
  window._trackingCompletionHandled = true;

  stopTrackingOrderCompletionPolling();

  if (window.trackingInterval) {
    clearInterval(window.trackingInterval);
    window.trackingInterval = null;
  }

  const message = "🎉 Ваш заказ успешно доставлен!";
  if (typeof tg?.showAlert === "function") {
    tg.showAlert(message);
  } else {
    alert(message);
  }

  window.closeTracking();
}

/** Светлая минималистичная схема (Glovo / Уклон). Leaflet: Carto Positron ≈ Google Maps `styles`. */
const TRACKING_MAP_ZOOM = 15;
const TRACKING_MAP_LEAFLET_OPTIONS = {
  zoomControl: false,
  attributionControl: false,
};
const TRACKING_MAP_TILE_URL =
  "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TRACKING_MAP_TILE_OPTIONS = {
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: "abcd",
  maxZoom: 20,
};

/** Кастомные иконки маркеров трекинга (Leaflet ≈ google.maps.Marker icon + scaledSize). */
const TRACKING_MARKER_ICON_URLS = {
  shop: "/uploads/icon_shop.png",
  courier: "/uploads/icon_courier.png",
  client: "/uploads/icon_client.png",
};
const TRACKING_MARKER_ICON_SIZES = {
  shop: [40, 40],
  courier: [42, 42],
  client: [40, 40],
};

let _trackingMapIcons = null;

function getTrackingMapIcons(L) {
  if (_trackingMapIcons) return _trackingMapIcons;

  const makeIcon = (key) => {
    const [w, h] = TRACKING_MARKER_ICON_SIZES[key];
    return L.icon({
      iconUrl: TRACKING_MARKER_ICON_URLS[key],
      iconSize: [w, h],
      iconAnchor: [w / 2, h / 2],
      popupAnchor: [0, -h / 2],
    });
  };

  _trackingMapIcons = {
    shop: makeIcon("shop"),
    courier: makeIcon("courier"),
    client: makeIcon("client"),
  };
  return _trackingMapIcons;
}

function initTrackingMapInstance(L, centerLatLng) {
  const map = L.map("map", {
    ...TRACKING_MAP_LEAFLET_OPTIONS,
    center: centerLatLng,
    zoom: TRACKING_MAP_ZOOM,
  });
  L.tileLayer(TRACKING_MAP_TILE_URL, TRACKING_MAP_TILE_OPTIONS).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  return map;
}

/** Интервал фонового обновления позиции курьера на карте (мс). */
const TRACKING_COURIER_POLL_MS = 12000;

let _trackingMarkerAnimationFrame = null;

function isOrderStatusDelivering(status) {
  const s = String(status || "").toLowerCase();
  return s === "delivery" || s === "delivering";
}

function parseCourierCoordsFromStatusPayload(payload) {
  if (!payload) return { lat: NaN, lon: NaN };
  const lat = parseFloat(payload.courier_lat);
  const lon = parseFloat(payload.courier_lon);
  return {
    lat: Number.isFinite(lat) ? lat : NaN,
    lon: Number.isFinite(lon) ? lon : NaN,
  };
}

function hasCourierCoordsInStatusPayload(payload) {
  if (!payload) return false;
  const lat = parseFloat(payload.courier_lat);
  const lon = parseFloat(payload.courier_lon);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat !== 0 &&
    lon !== 0
  );
}

/** Обновление маркера курьера на карте клиента (данные с /api/order_status). */
window.updateCourierMarkerOnMap = function updateCourierMarkerOnMap(
  lat,
  lon,
  options = {}
) {
  const L = window.L;
  const map = window.trackingMap || window.mapInstance;
  if (!L || !map) {
    return false;
  }

  const courierLatLng = [parseFloat(lat), parseFloat(lon)];
  if (
    !Number.isFinite(courierLatLng[0]) ||
    !Number.isFinite(courierLatLng[1]) ||
    courierLatLng[0] === 0
  ) {
    return false;
  }

  if (!window.courierMarker) {
    const courierIcon =
      options.icon ||
      getTrackingMapIcons(L).courier ||
      L.icon({
        iconUrl: TRACKING_MARKER_ICON_URLS.courier,
        iconSize: [42, 42],
        iconAnchor: [21, 21],
      });
    window.courierMarker = L.marker(courierLatLng, { icon: courierIcon })
      .addTo(map)
      .bindPopup("🛵 Курьер в пути");
  } else if (options.animate === true) {
    animateTrackingMarkerTo(
      window.courierMarker,
      courierLatLng[0],
      courierLatLng[1]
    );
  } else {
    window.courierMarker.setLatLng(courierLatLng);
  }

  window.deliverymanMarker = window.courierMarker;
  return true;
};

function updateCourierMarkerFromStatusData(data, courierIcon, options = {}) {
  if (!data) return false;
  if (data.courier_lat != null && data.courier_lon != null) {
    console.log(
      "📍 Перемещение маркера курьера на реальные координаты:",
      [parseFloat(data.courier_lat), parseFloat(data.courier_lon)]
    );
    return window.updateCourierMarkerOnMap(data.courier_lat, data.courier_lon, {
      icon: courierIcon,
      animate: options.animate === true,
    });
  }
  return false;
}

function cancelTrackingMarkerAnimation() {
  if (_trackingMarkerAnimationFrame) {
    cancelAnimationFrame(_trackingMarkerAnimationFrame);
    _trackingMarkerAnimationFrame = null;
  }
}

function animateTrackingMarkerTo(marker, targetLat, targetLon, durationMs = 1000) {
  const L = window.L;
  if (
    !L ||
    !marker ||
    !Number.isFinite(targetLat) ||
    !Number.isFinite(targetLon)
  ) {
    return;
  }
  const start = marker.getLatLng();
  const end = L.latLng(targetLat, targetLon);
  if (start.distanceTo(end) < TRACKING_COORD_EPSILON) {
    return;
  }

  cancelTrackingMarkerAnimation();
  const startTime = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / durationMs);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const lat = start.lat + (end.lat - start.lat) * eased;
    const lng = start.lng + (end.lng - start.lng) * eased;
    marker.setLatLng([lat, lng]);
    if (t < 1) {
      _trackingMarkerAnimationFrame = requestAnimationFrame(step);
    } else {
      _trackingMarkerAnimationFrame = null;
    }
  };
  _trackingMarkerAnimationFrame = requestAnimationFrame(step);
}

function fitTrackingMapToMarkers(map, markers, options = {}) {
  const L = window.L;
  if (!L || !map || !Array.isArray(markers) || markers.length === 0) return;

  const points = markers
    .map((m) => m?.getLatLng?.())
    .filter(
      (ll) =>
        ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng ?? ll.lon)
    );
  if (points.length === 0) return;

  if (points.length === 1) {
    map.setView(points[0], options.singleZoom ?? TRACKING_MAP_ZOOM);
    return;
  }

  const bounds = L.latLngBounds(points);
  map.fitBounds(bounds, {
    padding: options.padding ?? [50, 50],
    maxZoom: options.maxZoom ?? 16,
  });
}

let _leafletAssetsPromise = null;

async function loadLeafletAssets() {
  if (window.L) return window.L;

  if (_leafletAssetsPromise) {
    return _leafletAssetsPromise;
  }

  _leafletAssetsPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-halal-leaflet-css="1"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      link.setAttribute("data-halal-leaflet-css", "1");
      document.head.appendChild(link);
    }

    const existingScript = document.querySelector('script[data-halal-leaflet-js="1"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.L));
      existingScript.addEventListener("error", () => {
        _leafletAssetsPromise = null;
        reject(new Error("Не удалось загрузить Leaflet"));
      });
      if (window.L) resolve(window.L);
      return;
    }

    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.setAttribute("data-halal-leaflet-js", "1");
    script.onload = () => {
      console.log("🗺️ Leaflet успешно загружен на лету!");
      if (window.L) {
        resolve(window.L);
      } else {
        _leafletAssetsPromise = null;
        reject(new Error("Leaflet загружен, но window.L недоступен"));
      }
    };
    script.onerror = () => {
      _leafletAssetsPromise = null;
      reject(new Error("Не удалось загрузить Leaflet"));
    };
    document.body.appendChild(script);
  });

  return _leafletAssetsPromise;
}

window.showTrackingMap = async function (
  clientLat,
  clientLon,
  orderId,
  shopLatArg,
  shopLonArg
) {
  const screen = document.getElementById("tracking-screen");
  if (!screen) {
    console.error("tracking-screen недоступен");
    return;
  }

  let L;
  try {
    L = await loadLeafletAssets();
  } catch (err) {
    console.error(err);
    const msg = "Не удалось загрузить карту. Проверьте соединение.";
    if (typeof tg?.showAlert === "function") {
      tg.showAlert(msg);
    } else {
      alert(msg);
    }
    return;
  }

  hideActiveOrderFloatingButton();
  hideShopUiForTracking();
  screen.style.display = "flex";
  document.body.style.overflow = "hidden";

  _orderTrackingMediaKey = null;
  hideOrderTrackingBanner();

  const trackingOrderIdForMedia = getTrackingOrderIdFromUrl(orderId);

  const orderStatusPayload = await fetchOrderStatusPayload(
    trackingOrderIdForMedia,
    { courierView: isCourierTrackingViewMode() }
  );

  if (
    orderStatusPayload &&
    !isCourierMapTrackingAvailable(orderStatusPayload)
  ) {
    const msg = isCourierTrackingViewMode()
      ? "Не удалось загрузить маршрут доставки для этого заказа."
      : "Отслеживание на карте доступно только после оплаты, когда курьер нажмёт «Поехали».";
    if (typeof tg?.showAlert === "function") {
      tg.showAlert(msg);
    } else {
      alert(msg);
    }
    return;
  }

  const route = await resolveClientCoordsForTracking(
    {
      shop_latitude: shopLatArg,
      shop_longitude: shopLonArg,
      client_latitude: clientLat,
      client_longitude: clientLon,
      ...(orderStatusPayload || {}),
    },
    trackingOrderIdForMedia
  );

  if (orderStatusPayload) {
    renderOrderTrackingBanner(orderStatusPayload);
  }

  const runMapInit = () => {
    const mapEl = document.getElementById("map");
    if (!mapEl) return;

    window._trackingCompletionHandled = false;

    if (window.trackingInterval) {
      clearInterval(window.trackingInterval);
      window.trackingInterval = null;
    }
    cancelTrackingMarkerAnimation();
    window.courierMarker = null;
    window.deliverymanMarker = null;
    window._trackingShopMarker = null;
    window._trackingClientMarker = null;

    if (window.mapInstance) {
      window.mapInstance.remove();
      window.mapInstance = null;
    }
    window.trackingMap = null;
    if (mapEl._leaflet_id != null) {
      delete mapEl._leaflet_id;
    }

    const originLat = route.shopLat;
    const originLon = route.shopLon;
    const lat = route.clientLat;
    const lon = route.clientLon;
    const hasClientCoords = route.hasClient;

    const { shop: shopIcon, client: clientIcon, courier: courierIcon } =
      getTrackingMapIcons(L);

    window.mapInstance = initTrackingMapInstance(L, [originLat, originLon]);
    window.trackingMap = window.mapInstance;

    const trackingMarkers = [];

    window._trackingShopMarker = L.marker([originLat, originLon], {
      icon: shopIcon,
    })
      .addTo(window.mapInstance)
      .bindPopup("🏪 Магазин (ул. Ламаная, 2)");
    trackingMarkers.push(window._trackingShopMarker);

    if (
      hasClientCoords &&
      !trackingCoordsNearlyEqual(originLat, originLon, lat, lon)
    ) {
      window._trackingClientMarker = L.marker([lat, lon], { icon: clientIcon })
        .addTo(window.mapInstance)
        .bindPopup(
          isCourierTrackingViewMode()
            ? "🏠 Адрес клиента (точка Б)"
            : "🏠 Ваш адрес доставки"
        );
      trackingMarkers.push(window._trackingClientMarker);
    } else if (hasClientCoords) {
      console.error("Координаты клиента не заданы или дублируют магазин!");
    }

    const trackingOrderId = getTrackingOrderIdFromUrl(orderId);
    const initialStatus = String(orderStatusPayload?.status || "").toLowerCase();
    const showCourierOnMap =
      isOrderStatusDelivering(initialStatus) || isCourierTrackingViewMode();

    const refitTrackingMap = () => {
      const allMarkers = [
        window._trackingShopMarker,
        window._trackingClientMarker,
        window.courierMarker,
      ].filter(Boolean);
      fitTrackingMapToMarkers(window.mapInstance, allMarkers, {
        padding: [50, 50],
        maxZoom: 16,
      });
    };

    if (showCourierOnMap && orderStatusPayload) {
      updateCourierMarkerFromStatusData(orderStatusPayload, courierIcon, {
        animate: false,
      });
      if (
        window.courierMarker &&
        !trackingMarkers.includes(window.courierMarker)
      ) {
        trackingMarkers.push(window.courierMarker);
      }
    }

    refitTrackingMap();
    window._trackingShopMarker?.openPopup();

    const pollTrackingMapStatus = async () => {
      if (!trackingOrderId || !window.mapInstance) return;
      if (window._trackingCompletionHandled) return;

      try {
        const data = await fetchOrderStatusPayload(trackingOrderId, {
          courierView: isCourierTrackingViewMode(),
        });
        if (!data || window._trackingCompletionHandled) return;

        renderOrderTrackingBanner(data);

        const status = String(data.status || "").toLowerCase();
        if (status === "completed") {
          handleTrackingOrderCompleted();
          return;
        }

        if (data.courier_lat != null && data.courier_lon != null) {
          const hadCourier = Boolean(window.courierMarker);
          const moved = window.updateCourierMarkerOnMap(
            data.courier_lat,
            data.courier_lon,
            { icon: courierIcon, animate: hadCourier }
          );
          if (moved && !hadCourier) {
            refitTrackingMap();
          }
        }
      } catch (err) {
        console.error("tracking map order_status poll:", err);
      }
    };

    if (trackingOrderId) {
      stopTrackingOrderCompletionPolling();
      pollTrackingMapStatus();
      window.trackingInterval = setInterval(
        pollTrackingMapStatus,
        TRACKING_COURIER_POLL_MS
      );
    } else {
      console.warn("Трекинг: в URL нет order_id");
    }

    window.mapInstance.invalidateSize();
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(runMapInit);
  });
};

window.closeTracking = function () {
  stopTrackingOrderCompletionPolling();
  _orderTrackingMediaKey = null;
  hideOrderTrackingBanner();

  if (window.trackingInterval) {
    clearInterval(window.trackingInterval);
    window.trackingInterval = null;
  }
  cancelTrackingMarkerAnimation();
  window.courierMarker = null;
  window.deliverymanMarker = null;
  window._trackingShopMarker = null;
  window._trackingClientMarker = null;

  const screen = document.getElementById("tracking-screen");
  if (screen) screen.style.display = "none";
  document.body.style.overflow = "";

  if (window.mapInstance) {
    window.mapInstance.remove();
    window.mapInstance = null;
  }
  window.trackingMap = null;

  if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.close();
  }
};

function getGeolocationPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0,
    });
  });
}

function setCourierGoStatus(text) {
  const el = document.getElementById("courier-go-status");
  if (el) el.textContent = text || "";
}

function escapeJsStringAttr(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function openCourierNavigator(url) {
  if (!url) return;
  const absolute = /^https?:\/\//i.test(url)
    ? url
    : `${window.location.origin}${url.startsWith("/") ? url : `/${url}`}`;
  if (typeof window.Telegram?.WebApp?.openLink === "function") {
    window.Telegram.WebApp.openLink(absolute);
  } else {
    window.location.href = absolute;
  }
}

function showCourierDeliveryScreen(orderId, clientAddress = "") {
  const screen = document.getElementById("courier-delivery-screen");
  const label = document.getElementById("courier-order-id-label");
  if (!screen) return;

  document.body.style.overflow = "hidden";
  screen.style.display = "flex";

  const appRoot = document.getElementById("app-root");
  if (appRoot) appRoot.style.display = "none";

  const cartFab = document.querySelector(".cart-fab");
  if (cartFab) cartFab.style.display = "none";

  if (label) label.textContent = String(orderId || "—");
  setCourierGoStatus("");
  bindCourierGoButton(orderId, clientAddress);
}

function bindCourierGoButton(orderId, clientAddress = "") {
  const goBtn = document.getElementById("start-delivery-btn");
  if (!goBtn) return;

  const oid = escapeJsStringAttr(orderId);
  const addr = escapeJsStringAttr(clientAddress);
  goBtn.setAttribute(
    "onclick",
    `startCourierRoute('${oid}', '${addr}')`
  );
}

async function startCourierDeliveryApi(orderId, courierId) {
  const resolvedOrderId = getTrackingOrderIdFromUrl(orderId);
  if (!resolvedOrderId || !courierId) {
    return null;
  }

  let lat = null;
  let lon = null;
  try {
    const pos = await getGeolocationPosition();
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
  } catch (geoErr) {
    console.warn("courier geolocation:", geoErr);
  }

  const res = await fetch("/api/courier/start_delivery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      courier_id: courierId,
      user_id: courierId,
      order_id: resolvedOrderId,
      lat,
      lon,
    }),
  });
  return parseJsonResponse(res);
}

async function openCourierTrackingMap(orderId) {
  const resolvedOrderId = getTrackingOrderIdFromUrl(orderId);
  if (!resolvedOrderId) {
    const msg = "В ссылке не указан номер заказа (order_id).";
    if (typeof tg?.showAlert === "function") tg.showAlert(msg);
    else alert(msg);
    return false;
  }

  const { lat, lon } = getTrackingClientCoordsFromUrl();
  await window.showTrackingMap(lat, lon, resolvedOrderId);
  return true;
}

/** Прямая ссылка из чата: сначала карта А→Б, затем старт доставки (если есть Telegram ID). */
async function openCourierTrackingFromUrl(orderId) {
  const resolvedOrderId = getTrackingOrderIdFromUrl(orderId);
  if (!resolvedOrderId) {
    return false;
  }

  await openCourierTrackingMap(resolvedOrderId);

  const courierId = await waitForTelegramUserId();
  if (!courierId) {
    console.warn(
      "openCourierTrackingFromUrl: Telegram user id недоступен, карта без start_delivery"
    );
    return true;
  }

  try {
    await startCourierDeliveryApi(resolvedOrderId, courierId);
  } catch (err) {
    console.warn("openCourierTrackingFromUrl: start_delivery", err);
  }
  return true;
}

function sendCoordsToServer(orderId, lat, lon) {
  const resolvedOrderId = getTrackingOrderIdFromUrl(orderId) || String(orderId || "").trim();
  if (!resolvedOrderId) return;

  const courierId = getTelegramUserId();
  fetch("/api/courier/update_location", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      order_id: resolvedOrderId,
      lat,
      lon,
      courier_id: courierId || undefined,
      user_id: courierId || undefined,
    }),
  }).catch((err) => console.error("Ошибка отправки геопозиции:", err));
}

function stopCourierBackgroundGps() {
  if (window._courierGpsInterval) {
    clearInterval(window._courierGpsInterval);
    window._courierGpsInterval = null;
  }
}

window.startCourierRouteFromBtn = function startCourierRouteFromBtn() {
  const urlParams = new URLSearchParams(window.location.search);
  const labelEl = document.getElementById("courier-order-id-label");
  const labelOrderId = labelEl ? String(labelEl.textContent || "").trim() : "";
  const orderId =
    (labelOrderId && labelOrderId !== "—" ? labelOrderId : null) ||
    urlParams.get("order_id") ||
    "";
  const clientAddress =
    urlParams.get("address") ||
    urlParams.get("client_address") ||
    "";
  if (!orderId) {
    setCourierGoStatus("Не указан номер заказа.");
    return;
  }
  window.startCourierRoute(orderId, clientAddress);
};

window.startCourierRoute = function startCourierRoute(orderId, clientAddress) {
  const goBtn = document.getElementById("start-delivery-btn");
  const resolvedOrderId = getTrackingOrderIdFromUrl(orderId) || String(orderId || "").trim();

  if (!resolvedOrderId) {
    setCourierGoStatus("Не указан номер заказа.");
    return;
  }

  if (goBtn) goBtn.disabled = true;
  setCourierGoStatus("Запускаем GPS-трекинг…");

  const courierId = getTelegramUserId();
  if (courierId) {
    startCourierDeliveryApi(resolvedOrderId, courierId).catch((err) =>
      console.warn("startCourierRoute: start_delivery", err)
    );
  }

  stopCourierBackgroundGps();

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((position) => {
      sendCoordsToServer(
        resolvedOrderId,
        position.coords.latitude,
        position.coords.longitude
      );
    });

    window._courierGpsInterval = setInterval(() => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          sendCoordsToServer(
            resolvedOrderId,
            position.coords.latitude,
            position.coords.longitude
          );
        },
        (err) => console.error("Ошибка фонового GPS:", err),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    }, 30000);
  }

  setCourierGoStatus("Открываем навигатор…");

  const encodedAddress = encodeURIComponent(clientAddress || "");
  const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodedAddress}&travelmode=driving`;

  if (typeof window.Telegram?.WebApp?.openMapsUrl === "function") {
    window.Telegram.WebApp.openMapsUrl(googleMapsUrl);
  } else if (typeof window.Telegram?.WebApp?.openLink === "function") {
    window.Telegram.WebApp.openLink(googleMapsUrl);
  } else {
    window.open(googleMapsUrl, "_blank");
  }

  if (goBtn) goBtn.disabled = false;
};

window.courierStartDelivery = function courierStartDelivery(orderId) {
  const urlParams = new URLSearchParams(window.location.search);
  const clientAddress =
    urlParams.get("address") ||
    urlParams.get("client_address") ||
    "";
  return window.startCourierRoute(orderId, clientAddress);
};

function isCourierFastStartUrl() {
  if (window.COURIER_FAST_GO_ACTIVE) {
    return true;
  }
  const href = window.location.href;
  const hash = window.location.hash || "";
  return (
    href.includes("courier_fast_go") ||
    hash.includes("courier_fast_go") ||
    href.includes("courier/fast_start") ||
    hash.includes("courier/fast_start")
  );
}

function getCourierFastStartUrlParams() {
  const hash = window.location.hash || "";
  const hashQuery = hash.includes("?") ? hash.split("?")[1] : "";
  const searchQuery = (window.location.search || "").replace(/^\?/, "");
  const combined = [hashQuery, searchQuery].filter(Boolean).join("&");
  return new URLSearchParams(combined);
}

function bootCourierFastStartMode() {
  const urlParams = getCourierFastStartUrlParams();
  const orderId = urlParams.get("order_id");
  const clientAddress = decodeURIComponent(
    String(urlParams.get("address") || urlParams.get("client_address") || "")
  );

  const openGoogleMaps = () => {
    const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(clientAddress)}&travelmode=driving`;
    if (typeof window.Telegram?.WebApp?.openMapsUrl === "function") {
      window.Telegram.WebApp.openMapsUrl(googleMapsUrl);
      window.Telegram.WebApp.close();
    } else if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.openLink(googleMapsUrl);
      window.Telegram.WebApp.close();
    } else {
      window.location.href = googleMapsUrl;
    }
  };

  const postLocationAndStatus = async (lat, lon) => {
    const courierId = getTelegramUserId();
    await fetch("/api/courier/update_location_and_status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id: orderId,
        lat,
        lon,
        status: "delivering",
        courier_id: courierId || undefined,
        user_id: courierId || undefined,
      }),
    });
  };

  if (!orderId) {
    return;
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        try {
          await postLocationAndStatus(lat, lon);
        } catch (e) {
          console.error("Ошибка скрытой отправки гео:", e);
        }
        openGoogleMaps();
      },
      () => {
        openGoogleMaps();
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  } else {
    openGoogleMaps();
  }
}

function tryCourierFastStartFromUrl() {
  if (window.COURIER_FAST_GO_ACTIVE) {
    return Boolean(parseCourierFastGoUrlParamsEarly().get("order_id"));
  }
  if (!isCourierFastStartUrl()) {
    return false;
  }
  return Boolean(getCourierFastStartUrlParams().get("order_id"));
}

function tryStartCourierDeliveryFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("courier") !== "1") {
    return false;
  }

  const orderId = urlParams.get("order_id");
  if (!orderId) {
    return false;
  }

  const clientAddress =
    urlParams.get("address") ||
    urlParams.get("client_address") ||
    "";

  const openCourierScreen = () => {
    showCourierDeliveryScreen(orderId, clientAddress);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", openCourierScreen);
  } else {
    openCourierScreen();
  }
  return true;
}

function tryStartTrackingFromUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("track_order") !== "1") {
    return false;
  }

  const clientLat = parseFloat(urlParams.get("client_lat"));
  const clientLon = parseFloat(urlParams.get("client_lon"));
  const orderId = urlParams.get("order_id");
  const courierView = urlParams.get("courier_view") === "1";

  const openTracking = async () => {
    if (courierView && orderId) {
      await openCourierTrackingFromUrl(orderId);
      return;
    }
    await window.showTrackingMap(
      Number.isFinite(clientLat) ? clientLat : undefined,
      Number.isFinite(clientLon) ? clientLon : undefined,
      orderId
    );
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      openTracking();
    });
  } else {
    openTracking();
  }
  return true;
}

const COURIER_FAST_START_MODE = tryCourierFastStartFromUrl();
const TRACKING_MODE =
  !COURIER_FAST_START_MODE && tryStartTrackingFromUrl();
const COURIER_DELIVERY_MODE =
  !COURIER_FAST_START_MODE &&
  !TRACKING_MODE &&
  tryStartCourierDeliveryFromUrl();

function bootShopAfterTelegramReady() {
  if (shopTelegramUiReady) return;
  shopTelegramUiReady = true;

  tg.expand?.();
  loadGoogleMapsFromConfig();
  initCartAndOrderUi();
  window.updateCartUI();
  scheduleNonCriticalTask(() => {
    restoreCheckoutSessionIfNeeded();
  });
}

function bootShopApp() {
  if (window.COURIER_FAST_GO_ACTIVE) {
    if (typeof tg?.ready === "function") {
      tg.ready(() => tg.expand?.());
    } else {
      tg.expand?.();
    }
    return;
  }

  if (isCourierFastStartUrl()) {
    const runCourierFastStart = () => {
      tg.expand?.();
      bootCourierFastStartMode();
    };
    if (typeof tg?.ready === "function") {
      tg.ready(runCourierFastStart);
    } else {
      runCourierFastStart();
    }
    return;
  }

  if (TRACKING_MODE || COURIER_DELIVERY_MODE || COURIER_FAST_START_MODE) {
    if (typeof tg?.ready === "function") {
      tg.ready(() => tg.expand?.());
    } else {
      tg.expand?.();
    }
    return;
  }

  showAdminTriggerImmediately();
  ensureCatalogLayoutVisible();
  setupCatalogClickDelegation();

  const hasInstantCatalog = hydrateStoreFromBootstrap();
  if (hasInstantCatalog) {
    renderStoreFromCurrentData();
    scheduleCatalogImageWarmup();
  }

  initBanner();
  scheduleNonCriticalTask(() => {
    initMapBannerAdminInput();
  });
  loadCatalogFromServer({
    background: hasInstantCatalog,
    forceRender: !hasInstantCatalog,
  });

  scheduleActiveOrderRecovery();

  if (typeof tg?.ready === "function") {
    tg.ready(bootShopAfterTelegramReady);
  } else {
    bootShopAfterTelegramReady();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bootShopApp();
});
