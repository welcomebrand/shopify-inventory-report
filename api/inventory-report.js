/* =====================================================================
   Shopify Inventory Report API (Simple Daily Reconstruction)
   - Fully REST compliant
   - Calculates:
       • days in stock
       • stockout days
       • total sold
       • sold while in stock
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
  const list = [];
  const d = new Date(start);
  while (d <= end) {
    list.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return list;
}

function getRange(rangeParam) {
  const months = Number(rangeParam) || 24;
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  return {
    start,
    end,
    startDay: start.toISOString().slice(0, 10),
    endDay: end.toISOString().slice(0, 10),
    months
  };
}

/* ---------- Shopify REST Helper ---------- */
async function shopifyGET(path, params = {}) {
  const url = new URL(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/${path}.json`
  );

  Object.keys(params).forEach((k) =>
    url.searchParams.append(k, params[k])
  );

  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(
      `REST ${res.status}: ${txt}`
    );
  }

  return res.json();
}

/* ---------- 1. Fetch variants + inventory_item_ids ---------- */
async function fetchVariants() {
  let cursor = null;
  const variants = [];

  while (true) {
    const params = {
      limit: 250,
      fields: "id,variants",
      page_info: cursor
    };
    if (!cursor) delete params.page_info;

    const json = await shopifyGET("products", params);

    for (const product of json.products || []) {
      for (const v of product.variants || []) {
        if (v.sku && v.inventory_item_id) {
          variants.push({
            sku: v.sku,
            variantId: v.id,
            inventoryItemId: v.inventory_item_id
          });
        }
      }
    }

    const link = json.headers?.link || "";
    if (!link.includes('rel="next"')) break;

    cursor = link.match(/page_info=([^&>]+)/)?.[1];
    if (!cursor) break;
  }

  return variants;
}

/* ---------- 2. Fetch current inventory level (today) ---------- */
async function fetchCurrentLevel(inventoryItemId) {
  const json = await shopifyGET("inventory_levels", {
    inventory_item_ids: inventoryItemId
  });

  if (!json.inventory_levels || json.inventory_levels.length === 0) return 0;

  return json.inventory_levels[0].available || 0;
}

/* ---------- 3. Fetch sales in date range ---------- */
async function fetchOrders(startDay, endDay) {
  const sales = [];
  let cursor = null;

  while (true) {
    const params = {
      limit: 250,
      status: "any",
      created_at_min: `${startDay}T00:00:00Z`,
      created_at_max: `${endDay}T23:59:59Z`,
      page_info: cursor
    };
    if (!cursor) delete params.page_info;

    const json = await shopifyGET("orders", params);

    for (const order of json.orders || []) {
      const date = order.created_at.slice(0, 10);
      for (const li of order.line_items || []) {
        if (!li.sku) continue;
        sales.push({
          date,
          sku: li.sku,
          qty: li.quantity
        });
      }
    }

    const link = json.headers?.link || "";
    if (!link.includes('rel="next"')) break;

    cursor = link.match(/page_info=([^&>]+)/)?.[1];
    if (!cursor) break;
  }

  return sales;
}

/* ---------- 4. Reconstruct daily inventory (simple model) ---------- */
function reconstructDailyInventory(startDay, endDay, finalQty, salesForSku) {
  const days = enumerateDays(startDay, endDay);

  // Initialise all as zero stock
  const inventory = {};
  days.forEach((d) => (inventory[d] = 0));

  // Assume the final day stock is correct
  let running = finalQty;

  // Work backwards for each day
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    const sold = salesForSku[day] || 0;

    inventory[day] = running;
    running += sold; // simple reconstruction: add back what sold that day
  }

  return inventory;
}

/* ---------- 5. Calculate Metrics ---------- */
function calculateMetrics(inventory, salesForSku) {
  let daysInStock = 0;
  let stockoutDays = 0;
  let totalSold = 0;
  let soldWhileInStock = 0;

  for (const day of Object.keys(inventory)) {
    const qty = inventory[day];
    const sold = salesForSku[day] || 0;
    totalSold += sold;

    if (qty > 0) {
      daysInStock++;
      soldWhileInStock += sold;
    } else {
      stockoutDays++;
    }
  }

  return {
    days_in_stock: daysInStock,
    stockout_days: stockoutDays,
    sold_while_in_stock: soldWhileInStock,
    total_sold: totalSold
  };
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
      error: "Missing Shopify environment variables"
    });
  }

  try {
    const { startDay, endDay, start, end, months } = getRange(req.query.range);

    const variants = await fetchVariants();
    const orders = await fetchOrders(startDay, endDay);

    const output = {};

    for (const v of variants) {
      // Build sales map for this SKU
      const salesMap = {};
      for (const o of orders) {
        if (o.sku === v.sku) {
          salesMap[o.date] = (salesMap[o.date] || 0) + o.qty;
        }
      }

      // Final known stock today
      const finalQty = await fetchCurrentLevel(v.inventoryItemId);

      // Reconstruct daily inventory
      const inventory = reconstructDailyInventory(startDay, endDay, finalQty, salesMap);

      // Metrics
      const metrics = calculateMetrics(inventory, salesMap);

      output[v.sku] = {
        sku: v.sku,
        ...metrics
      };
    }

    return res.status(200).json({
      ok: true,
      start_date: startDay,
      end_date: endDay,
      range_months: months,
      items: output
    });

  } catch (err) {
    console.error("Inventory report error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
