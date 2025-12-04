/* =====================================================================
   Shopify Inventory Report API
   - Uses 24m (or ?range=N months) of orders
   - Calculates per-SKU:
       - days_in_stock
       - stockout_days
       - sold_while_in_stock
       - total_sold
   - CORS + Cache match knife-sales-stats.js
===================================================================== */

/* ---------------- ENV ---------------- */
const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

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
  res.setHeader(
    "Cache-Control",
    "s-maxage=14400, stale-while-revalidate=86400"
  );
}

/* ------------ Date Range from ?range= ------------ */
function getDateRange(rangeParam) {
  const months = Number(rangeParam) || 24;

  const end = new Date(); // now
  const start = new Date();
  start.setUTCDate(15); // prevent rollover weirdness
  start.setUTCMonth(start.getUTCMonth() - months);

  const startDateObj = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endDateObj   = end;

  const fmtDate = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

  return {
    // for display
    startDate: fmtDate(startDateObj),
    endDate: fmtDate(endDateObj),
    // for querying
    startISO: startDateObj.toISOString(),
    endISO: endDateObj.toISOString(),
    months,
  };
}

/* ------------ Shopify GraphQL Helper ------------ */
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Shopify:\n${text}`);
  }

  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors || text)}`);
  }

  return json.data;
}

/* ------------ Fetch All Variants + inventoryItemIds ------------ */
async function fetchAllVariants() {
  const variants = [];
  let cursor = null;

  const query = `
    query FetchVariants($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  inventoryItem { id }
                }
              }
            }
          }
        }
      }
    }
  `;

  while (true) {
    const data = await shopifyGraphQL(query, { cursor });
    const edges = data.products.edges || [];

    for (const edge of edges) {
      for (const vEdge of edge.node.variants.edges || []) {
        const v = vEdge.node;
        if (!v.sku) continue;              // we only care about variants with SKUs
        if (!v.inventoryItem?.id) continue; // must have inventory item id
        variants.push(v);
      }
    }

    if (!data.products.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  return variants;
}

/* ------------ Fetch Daily Inventory per inventoryItemId ------------ */
/* NOTE: This depends on Shopify exposing inventory history.
   If Shopify returns an error for this field, you’ll see it in logs
   and days_in_stock / stockout_days will remain 0. */
async function fetchInventoryDailyForItem(inventoryItemId, start, end) {
  const query = `
    query InvDaily($id: ID!, $start: DateTime!, $end: DateTime!) {
      inventoryItem(id: $id) {
        inventoryHistory(first: 250, occurredAtMin: $start, occurredAtMax: $end) {
          edges {
            node {
              occurredAt
              availableDelta
              availableAfterAdjustment
            }
          }
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, {
    id: inventoryItemId,
    start,
    end
  });

  const hist = data?.inventoryItem?.inventoryHistory?.edges || [];

  // Build a map of date → available (end-of-day snapshot approximation)
  const byDate = {};
  for (const edge of hist) {
    const node = edge.node;
    const date = node.occurredAt.slice(0, 10); // YYYY-MM-DD
    // Keep the last availableAfterAdjustment we see for that date
    byDate[date] = node.availableAfterAdjustment;
  }

  // Convert to array form like: [{ date, available }]
  return Object.entries(byDate).map(([date, available]) => ({ date, available }));
}

/* ------------ Fetch Orders in Date Range (GraphQL) ------------ */
/* Uses pattern similar to knife-sales-stats, which we know works */
async function fetchOrders(startISO) {
  const results = [];
  let cursor = null;

  const ORDERS_QUERY = `
    query Orders($cursor: String, $query: String!) {
      orders(
        first: 100
        after: $cursor
        query: $query
        sortKey: CREATED_AT
      ) {
        pageInfo { hasNextPage }
        edges {
          cursor
          node {
            createdAt
            lineItems(first: 100) {
              edges {
                node {
                  quantity
                  variant { id }
                }
              }
            }
          }
        }
      }
    }
  `;

  // Order creation date based window - per your preference
  const queryString = `created_at:>=${startISO}`;

  while (true) {
    const data = await shopifyGraphQL(ORDERS_QUERY, {
      cursor,
      query: queryString
    });

    const edges = data.orders.edges || [];

    for (const edge of edges) {
      const order = edge.node;
      const items = (order.lineItems.edges || []).map(liEdge => {
        const li = liEdge.node;
        return {
          variantId: li.variant?.id || null,
          quantity: li.quantity || 0
        };
      });

      results.push({
        createdAt: order.createdAt,
        lineItems: items
      });
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = edges[edges.length - 1].cursor;
  }

  return results;
}

/* ------------ Compute Metrics ------------ */
function computeMetrics(variants, inventoryByItem, orders, startDate, endDate) {
  const skuByVariantId = {};
  const itemIdBySku = {};

  // Map variant → SKU, SKU → inventoryItemId
  variants.forEach((v) => {
    const sku = String(v.sku).trim();
    if (!sku) return;
    if (!v.inventoryItem?.id) return;

    skuByVariantId[v.id] = sku;
    itemIdBySku[sku] = v.inventoryItem.id;
  });

  // Build sales index: (date|sku) → qty
  const sales = {};
  orders.forEach((order) => {
    const date = order.createdAt.slice(0, 10); // YYYY-MM-DD

    order.lineItems.forEach((li) => {
      if (!li.variantId) return;

      const sku = skuByVariantId[li.variantId];
      if (!sku) return;

      const key = `${date}|${sku}`;
      sales[key] = (sales[key] || 0) + li.quantity;
    });
  });

  // Build list of dates in period
  const dates = [];
  let d = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");

  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  // Compute per SKU metrics
  const output = {};

  for (const [sku, invItemId] of Object.entries(itemIdBySku)) {
    const invRaw = inventoryByItem[invItemId] || [];
    const invMap = {};
    invRaw.forEach((e) => {
      invMap[e.date] = e.available;
    });

    let daysInStock = 0;
    let stockoutDays = 0;
    let soldWhileInStock = 0;
    let totalSold = 0;

    // Optional: daily breakdown if you want it later
    // const daily = {};

    for (const date of dates) {
      const qtyAvail = invMap[date] ?? 0;
      const sold = sales[`${date}|${sku}`] || 0;

      totalSold += sold;

      if (qtyAvail > 0) {
        daysInStock++;
        soldWhileInStock += sold;
      } else {
        stockoutDays++;
      }

      // daily[date] = { available: qtyAvail, sold };
    }

    output[sku] = {
      sku,
      days_in_stock: daysInStock,
      stockout_days: stockoutDays,
      sold_while_in_stock: soldWhileInStock,
      total_sold: totalSold
      // daily
    };
  }

  return output;
}

/* ------------ EXPORT HANDLER ------------ */
module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  applyEdgeCache(res);

  if (!STORE_DOMAIN || !ADMIN_TOKEN) {
    return res.status(500).json({
      ok: false,
      error: "Missing Shopify environment variables",
    });
  }

  try {
    const { startDate, endDate, startISO, endISO, months } = getDateRange(
      req.query.range
    );

    // 1) All variants (with SKUs + inventory items)
    const variants = await fetchAllVariants();

    // 2) Inventory history per item
    const inventoryByItem = {};
    const ids = [
      ...new Set(
        variants.map((v) => v.inventoryItem?.id).filter(Boolean)
      ),
    ];

    // Batch in chunks (avoid hammering API)
    for (let i = 0; i < ids.length; i += 10) {
      const batch = ids.slice(i, i + 10);
      await Promise.all(
        batch.map(async (id) => {
          try {
            inventoryByItem[id] = await fetchInventoryDailyForItem(
              id,
              startISO,
              endISO
            );
          } catch (err) {
            console.error("Inventory history error for", id, err);
            inventoryByItem[id] = []; // fallback → no history
          }
        })
      );
    }

    // 3) Orders in date range (24m default, using creation date)
    const orders = await fetchOrders(startISO);

    // 4) Compute per-SKU metrics
    const metrics = computeMetrics(
      variants,
      inventoryByItem,
      orders,
      startDate,
      endDate
    );

    return res.status(200).json({
      ok: true,
      range_months: months,
      start_date: startDate,
      end_date: endDate,
      generated_at: new Date().toISOString(),
      items: metrics,
    });
  } catch (err) {
    console.error("inventory-report error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err),
    });
  }
};
