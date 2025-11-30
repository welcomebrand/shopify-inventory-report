
/* =====================================================================
   Shopify Inventory Report API (Universal / No Special Permissions)
   - Uses inventory_levels + inventory_item adjustments
   - Reconstructs daily inventory levels
   - Safe for all Shopify plans and API versions
===================================================================== */

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

/* ---------- CORS (same as knife-sales-stats) ---------- */
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

/* ---------- Caching (same as knife-sales-stats) ---------- */
function applyCache(res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=14400, stale-while-revalidate=86400"
  );
}

/* ---------- Date Helpers ---------- */
function getMonthsAgoRange(rangeParam) {
  const months = Number(rangeParam) || 24;

  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  const iso = (d) => d.toISOString();
  const day = (d) => iso(d).slice(0, 10);

  return {
    start,
    end,
    startDay: day(start),
    endDay: day(end),
    months,
  };
}

function enumerateDays(start, end) {
  const days = [];
  const d = new Date(start);

  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
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
    throw new Error(`Shopify REST error: ${res.status} ${txt}`);
  }

  return res.json();
}

/* ---------- Step 1: Fetch variants + inventory_item_ids ---------- */
async function fetchAllVariants() {
  let pageInfo = null;
  const variants = [];

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
            variantId: v.id,
            sku: v.sku,
            inventoryItemId: v.inventory_item_id,
          });
        }
      }
    }

    const link = json.headers?.link || res.headers?.get("link");
    if (!link || !link.includes('rel="next"')) break;

    const match = link.match(/page_info=([^&>]+)/);
    if (!match) break;

    pageInfo = match[1];
  }

  return variants;
}

/* ---------- Step 2: Fetch inventory adjustments per inventory_item ---------- */
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

/* ---------- Step 3: Fetch orders (to calculate sold-on-days-in-stock) ---------- */
async function fetchOrders(startDay, endDay) {
  const output = [];
  let pageInfo = null;

  while (true) {
    const params = {
      limit: 250,
      status: "any",
      created_at_min: `${startDay}T00:00:00Z`,
      created_at_max: `${endDay}T23:59:59Z`,
    };

    if (pageInfo) params.page_info = pageInfo;

    const json = await shopifyGET("orders", params);

    for (const o of json.orders || []) {
      for (const li of o.line_items || []) {
        if (!li.sku) continue;

        output.push({
          date: o.created_at.slice(0, 10),
          sku: li.sku,
          qty: li.quantity,
        });
      }
    }

    const link = json.headers?.link || "";
    if (!link.includes('rel="next"')) break;

    const match = link.match(/page_info=([^&>]+)/);
    if (!match) break;

    pageInfo = match[1];
  }

  return output;
}

/* ---------- Step 4: Build daily stock levels ---------- */
function reconstructDailyLevels(startDay, endDay, adjustments) {
  const days = enumerateDays(new Date(startDay), new Date(endDay));
  const daily = {};
  let running = 0;

  for (const d of days) daily[d] = 0;
  for (const adj of adjustments) {
    if (!daily[adj.date]) continue;
    daily[adj.date] += adj.delta;
  }

  return daily;
}

/* ---------- Step 5: Build metrics per SKU ---------- */
function calculateMetrics(variants, invMapByItem, orders, startDay, endDay) {
  const days = enumerateDays(new Date(startDay), new Date(endDay));

  const ordersByDateSku = {};
  for (const o of orders) {
    const key = `${o.date}|${o.sku}`;
    ordersByDateSku[key] = (ordersByDateSku[key] || 0) + o.qty;
  }

  const output = {};

  for (const v of variants) {
    const sku = v.sku;
    const invDaily = invMapByItem[v.inventoryItemId] || {};
    let daysInStock = 0;
    let stockoutDays = 0;
    let totalSold = 0;
    let soldWhileInStock = 0;

    for (const d of days) {
      const qty = invDaily[d] ?? 0;
      const sold = ordersByDateSku[`${d}|${sku}`] || 0;

      totalSold += sold;

      if (qty > 0) {
        daysInStock++;
        soldWhileInStock += sold;
      } else {
        stockoutDays++;
      }
    }

    output[sku] = {
      sku,
      total_sold: totalSold,
      sold_while_in_stock: soldWhileInStock,
      days_in_stock: daysInStock,
      stockout_days: stockoutDays,
      daily: invDaily,
    };
  }

  return output;
}

/* =====================================================================
   MAIN HANDLER
===================================================================== */
module.exports = async (req, res) => {
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

    const orders = await fetchOrders(startDay, endDay);

    const results = calculateMetrics(
      variants,
      invMapByItem,
      orders,
      startDay,
      endDay
    );

    return res.status(200).json({
      ok: true,
      range_months: months,
      start_date: startDay,
      end_date: endDay,
      items: results,
    });
  } catch (err) {
    console.error("Inventory report error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
};
