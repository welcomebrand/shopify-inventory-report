const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

module.exports = async (req, res) => {
  const { id } = req.query;
  if (!id) {
    return res.json({ ok: false, error: "Pass ?id=INVENTORY_ITEM_ID" });
  }

  const query = `
    query TestInventory($id: ID!) {
      inventoryItem(id: $id) {
        id
        inventoryLevels(first: 10) {
          edges {
            node {
              available
              location {
                name
              }
            }
          }
        }
        inventoryHistory(first: 10) {
          edges {
            node {
              occurredAt
              availableAfterAdjustment
            }
          }
        }
      }
    }
  `;

  const data = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": ADMIN_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { id } }),
    }
  );

  const text = await data.text();
  let json;
  try { json = JSON.parse(text); }
  catch { return res.json({ raw: text }); }

  res.json(json);
};
