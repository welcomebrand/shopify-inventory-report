/* =====================================================================
   CEK Sell-Through API
   - Combines Shopify orders (24m) with Google Sheet sell-through export
   - Uses same CORS + Cache behaviour as knife-sales-stats
===================================================================== */

/* ---------------- ENV ---------------- */
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const SHEET_CSV_URL = process.env.SELLTHROUGH_SHEET_CSV_URL;

/* ------------ CORS (match sales API) ------------ */
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

/* ------------ Edge Cache (match sales API) ------------ */
function applyEdgeCache(res) {
  // 4 hours at the edge, 1 day stale-while-revalidate
  res.setHeader(
    "Cache-Control",
    "s-maxage=14400, stale-while-revalidate=86400"
  );
}

/* ------------ Date helpers (24 months window) ------------ */
function monthsAgo(date, n) {
  const d = new Date(date);
  d.setUTCDate(15); // prevent rollover
  d.setUTCMonth(d.getUTCMonth() - n);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/* ------------ SKU normalisation ------------ */
/**
 * Normalises SKUs like:
 *  - "HAT-053-##"        -> "HAT-053"
 *  - "CUS-0028   ##"     -> "CUS-0028"
 *  - "50002"             -> "50002"
 */
function normaliseSku(sku) {
  if (!sku) return null;
  return String(sku)
    .trim()
    // strip trailing " -##" or "   ##" patterns
    .replace(/\s*-#+\s*$/, "");
}

/* ------------ Shopify GraphQL helper ------------ */
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch (err) {
    console.error("Invalid JSON from Shopify:", text);
    throw new Error("Invalid JSON from Shopify (see logs)");
  }

  if (!res.ok || json.errors) {
    console.error("Shopify GraphQL error:", json.errors || text);
    throw new Error("Shopify GraphQL error (see logs)");
  }

  return json.data;
}

/* ------------ Fetch orders for last N months (default 24) ------------ */
async function fetchSalesBySku(months = 24) {
  const now = new Date();
  const cutoff = monthsAgo(now, months);

  const ORDERS_QUERY = `
    query Orders($cursor: String, $query: String!) {
      orders(
        first: 100
        after: $cursor
        query: $query
        sortKey: CREATED_AT
      ) {
        edges {
          cursor
          node {
            createdAt
            lineItems(first: 100) {
              edges {
                node {
                  sku
                  quantity
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
        }
      }
    }
  `;

  const stats = {};
  function ensureSku(skuNorm, skuRaw) {
    if (!skuNorm) return null;
    if (!stats[skuNorm]) {
      stats[skuNorm] = {
        sku: skuNorm,
        any_raw_sku: skuRaw || skuNorm,
        total_sold_24m: 0
      };
    }
    return stats[skuNorm];
  }

  let cursor = null;
  let hasNext = true;
  const queryString = `created_at:>=${cutoff.toISOString()}`;

  while (hasNext) {
    const data = await shopifyGraphQL(ORDERS_QUERY, {
      cursor,
      query: queryString
    });

    const edges = data.orders.edges || [];
    hasNext = data.orders.pageInfo?.hasNextPage || false;

    for (const edge of edges) {
      const order = edge.node;
      const orderDate = new Date(order.createdAt);

      if (orderDate < cutoff) continue;

      for (const liEdge of order.lineItems.edges) {
        const li = liEdge.node;
        const rawSku = li.sku ? String(li.sku).trim() : null;
        const skuNorm = normaliseSku(rawSku);
        if (!skuNorm) continue;

        const s = ensureSku(skuNorm, rawSku);
        const qty = li.quantity || 0;
        s.total_sold_24m += qty;
      }
    }

    if (edges.length > 0) {
      cursor = edges[edges.length - 1].cursor;
    } else {
      break;
    }
  }

  return {
    cutoffDate: cutoff.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
    stats
  };
}

/* ------------ Minimal CSV parser (handles quotes & commas) ------------ */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '"' && inQuotes && next === '"') {
      // Escaped quote ""
      field += '"';
      i++; // skip next
    } else if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((c === "\n" || c === "\r") && !inQuotes) {
      if (field !== "" || row.length > 0) {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      }
      // swallow CRLF combos
      if (c === "\r" && next === "\n") i++;
    } else {
      field += c;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/* ------------ Fetch + parse Google Sheet CSV ------------ */
async function fetchSheetBySku() {
  if (!SHEET_CSV_URL) {
    throw new Error("SELLTHROUGH_SHEET_CSV_URL is not set");
  }

  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) {
    const text = await res.text();
    console.error("Error fetching sheet:", res.status, text);
    throw new Error("Failed to fetch sell-through sheet (see logs)");
  }

  const csvText = await res.text();
  const rows = parseCsv(csvText);

  if (!rows.length) {
    throw new Error("Sell-through sheet appears to be empty");
  }

  const header = rows[0].map((h) => h.trim());
  const idx = {
    productTitle: header.indexOf("Product title"),
    variantTitle: header.indexOf("Product variant title"),
    sku: header.indexOf("Product variant SKU"),
    abc: header.indexOf("Product variant ABC grade"),
    sellThroughRate: header.indexOf("Sell-through rate"),
    inventoryUnitsSold: header.indexOf("Inventory units sold"),
    startingUnits: header.indexOf("Starting inventory units"),
    endingUnits: header.indexOf("Ending inventory units"),
    daysInStock: header.indexOf("Days in stock (at location)"),
    daysOutOfStock: header.indexOf("Days out of stock (at location)"),
    percentInventorySold: header.indexOf("Percent of inventory sold")
  };

  // sanity check: required columns
  if (idx.sku === -1 || idx.daysInStock === -1) {
    console.error("Header row:", header);
    throw new Error(
      "Expected columns 'Product variant SKU' and 'Days in stock (at location)' not found in sheet header"
    );
  }

  const bySku = {};

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rawSku = row[idx.sku] ? String(row[idx.sku]).trim() : "";
    if (!rawSku) continue;

    const skuNorm = normaliseSku(rawSku);
    if (!skuNorm) continue;

    const daysInStock =
      idx.daysInStock >= 0 ? Number(row[idx.daysInStock] || 0) : 0;
    const daysOutOfStock =
      idx.daysOutOfStock >= 0 ? Number(row[idx.daysOutOfStock] || 0) : 0;

    const inventoryUnitsSold =
      idx.inventoryUnitsSold >= 0
        ? Number(row[idx.inventoryUnitsSold] || 0)
        : null;

    const sellThroughRate =
      idx.sellThroughRate >= 0
        ? Number(String(row[idx.sellThroughRate]).replace("%", "")) || null
        : null;

    const percentInventorySold =
      idx.percentInventorySold >= 0
        ? Number(String(row[idx.percentInventorySold]).replace("%", "")) || null
        : null;

    bySku[skuNorm] = {
      sku_norm: skuNorm,
      sku_raw: rawSku,
      product_title: idx.productTitle >= 0 ? row[idx.productTitle] || "" : "",
      variant_title: idx.variantTitle >= 0 ? row[idx.variantTitle] || "" : "",
      abc_grade: idx.abc >= 0 ? row[idx.abc] || "" : "",
      days_in_stock_24m: daysInStock,
      days_out_of_stock_24m: daysOutOfStock,
      inventory_units_sold_csv: inventoryUnitsSold,
      sell_through_rate_csv: sellThroughRate, // as %
      percent_inventory_sold_csv: percentInventorySold // as %
    };
  }

  return bySku;
}

/* ------------ Merge Shopify sales + sheet ------------ */
function mergeSalesAndSheet(salesStats, sheetStats) {
  const items = {};
  const allSkus = new Set([
    ...Object.keys(salesStats),
    ...Object.keys(sheetStats)
  ]);

  for (const sku of allSkus) {
    const sales = salesStats[sku] || {
      sku,
      any_raw_sku: sku,
      total_sold_24m: 0
    };

    const sheet = sheetStats[sku] || {
      sku_norm: sku,
      sku_raw: sales.any_raw_sku || sku,
      product_title: "",
      variant_title: "",
      abc_grade: "",
      days_in_stock_24m: 0,
      days_out_of_stock_24m: 0,
      inventory_units_sold_csv: null,
      sell_through_rate_csv: null,
      percent_inventory_sold_csv: null
    };

    const totalDays =
      sheet.days_in_stock_24m + sheet.days_out_of_stock_24m || 0;

    const inStockRate =
      totalDays > 0 ? sheet.days_in_stock_24m / totalDays : null;

    const velocityInStock =
      sheet.days_in_stock_24m > 0
        ? sales.total_sold_24m / sheet.days_in_stock_24m
        : null;

    items[sku] = {
      sku_norm: sku,
      sku_raw: sheet.sku_raw || sales.any_raw_sku || sku,
      product_title: sheet.product_title,
      variant_title: sheet.variant_title,
      abc_grade: sheet.abc_grade,

      // From Shopify orders (24m)
      total_sold_24m: sales.total_sold_24m,

      // From Sheet (24m window of the report)
      days_in_stock_24m: sheet.days_in_stock_24m,
      days_out_of_stock_24m: sheet.days_out_of_stock_24m,
      in_stock_rate_24m: inStockRate, // 0–1

      // Derived KPI: how fast it sells when actually available
      velocity_in_stock_24m: velocityInStock, // units per in-stock day

      // Raw sheet stats (for reference / debugging)
      inventory_units_sold_csv: sheet.inventory_units_sold_csv,
      sell_through_rate_csv: sheet.sell_through_rate_csv,
      percent_inventory_sold_csv: sheet.percent_inventory_sold_csv
    };
  }

  return items;
}

/* ------------ EXPORT HANDLER ------------ */
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  applyEdgeCache(res);

  if (!STORE_DOMAIN || !ADMIN_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing Shopify environment variables"
    });
  }

  try {
    const months = Number(req.query.months) || 24;

    // 1) Shopify sales (last N months, default 24)
    const {
      cutoffDate,
      endDate,
      stats: salesStats
    } = await fetchSalesBySku(months);

    // 2) Sell-through sheet (24m window as exported)
    const sheetStats = await fetchSheetBySku();

    // 3) Merge
    const items = mergeSalesAndSheet(salesStats, sheetStats);

    return res.status(200).json({
      ok: true,
      start_date: cutoffDate,
      end_date: endDate,
      range_months: months,
      generated_at: new Date().toISOString(),
      item_count: Object.keys(items).length,
      items
    });
  } catch (err) {
    console.error("sell-through API error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
};
