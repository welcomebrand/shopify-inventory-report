/* =====================================================================
   Shopify Inventory Report API (Diagnostic-Safe Version)
===================================================================== */

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

/* ---------- CORS ---------- */
function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return true;
  }
  return false;
}

/* ---------- Cache ---------- */
function applyCache(res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=14400, stale-while-revalidate=86400"
  );
}

/* ---------- Date Helpers ---------- */
function enumerateDays(start, end) {
  const out = [];
  const d = new Date(start);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function getMonthsAgoRange(rangeParam) {
  const months = Number(rangeParam) || 24;

  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  const fmt = (d) => d.toISOString().slice(0, 10);

  return {
    start,
    end,
    startDay: fmt(start),
    endDay: fmt(end),
    months,
  };
}

/* ---------- Shopify REST Helper ---------- */
async function shopifyGET(path, params = {}) {
  const url = new URL(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/${path}.json`
  );
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `Shopify REST ${res.status}: ${txt}`
    );
  }

  return res.json();
}

/* ---------- Step 1: Fetch Variants ---------- */
async function fetchAllVariants() {
  const variants = [];
  let pageInfo = null;

  while (true) {
    const params = {
      limit: 250,
      fields: "id,variants",
    };
    if (pageInfo) params.page_info = pageInfo;

    const json = await shopifyGET("products", params);

    for (const p of json.products || []) {
      for (const v of p.variants || []) {
        if (v.sku && v.inventory_item_id) {
          variants.push({
            sku: v.sku,
            inventoryItemId: v.inventory_item_id,
          });
        }
      }
    }

    const link = json.headers?.link || "";
    if (!link.includes('rel="next"')) break;

    const match = link.match(/page_info=([^&>]+)/);
    if (!match) break;

    pageInfo = match[1];
  }

  return variants;
}

/* ---------- Step 2: Inventory Adjustments ---------- */
async function fetchAdjustments(inventoryItemId, startDay, endDay) {
  const json = await shopifyGET(
    `inventory_items/${inventoryItemId}/inventory_levels`,
    {}
  );

  const levels = json.inventory_levels || [];
  if (levels.length === 0) return [];

  const locationId = levels[0].location_id;

  const adjustments = [];
  let pageInfo = null;

  while (true) {
    const params = {
      limit: 250,
      location_id: locationId,
      updated_at_min: `${startDay}T00:00:00Z`,
      updated_at_max: `${endDay}T23:59:59Z`,
    };
    if (pageInfo) params.page_info = pageInfo;

    const res = await shopifyGET(
      `inventory_items/${inventoryItemId}/inventory_levels/adjustments`,
      params
    );

    for (const adj of res.inventory_level_adjustments || []) {
      adjustments.push({
        date: adj.performed_at.slice(0, 10),
        delta: adj.quantity,
      });
    }

    const link = res.headers?.link || "";
    if (!link.includes('rel="next"')) break;

    const match = link.match(/page_info=([^&>]+)/);
    if (!match) break;

    pageInfo = match[1];
  }

  return adjustments;
}

/* ---------- Step 3: Reconstruct daily levels ---------- */
function reconstructDailyLevels(startDay, endDay, adjustments) {
  const days = enumerateDays(new Date(startDay), new Date(endDay));
  const map = {};

  days.forEach((d) => (map[d] = 0));

  adjustments.forEach((a) => {
    if (map[a.date] !== undefined) {
      map[a.date] += a.delta;
    }
  });

  return map;
}

/* ---------- Main Handler ---------- */
module.exports = async (req, res) => {
  // ******** SAFE DEBUG LOGS ********
  console.log("DEBUG ENV VARS:", {
    STORE_DOMAIN,
    ADMIN_TOKEN,
    API_VERSION
  });

  if (applyCors(req, res)) return;
  applyCache(res);

  if (!STORE_DOMAIN || !ADMIN_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing Shopify environment variables",
    });
  }

  try {
    const { startDay, endDay, months } = getMonthsAgoRange(req.query.range);

    const variants = await fetchAllVariants();

    const invMapByItem = {};
    for (const v of variants) {
      const adjustments = await fetchAdjustments(
        v.inventoryItemId,
        startDay,
        endDay
      );
      invMapByItem[v.inventoryItemId] = reconstructDailyLevels(
        startDay,
        endDay,
        adjustments
      );
    }

    return res.status(200).json({
      ok: true,
      months,
      startDay,
      endDay,
      diagnostics: {
        variants: variants.length,
        inventoryItems: Object.keys(invMapByItem).length,
      }
    });
  } catch (err) {
    console.error("Inventory report error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
