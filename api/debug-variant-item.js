const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

module.exports = async (req, res) => {
  const { variant } = req.query;
  if (!variant) {
    return res.json({ error: "Pass ?variant=VARIANT_ID" });
  }

  const gql = `
    query GetVariant($id: ID!) {
      productVariant(id: $id) {
        id
        sku
        inventoryItem {
          id
        }
      }
    }
  `;

  const r = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({
      query: gql,
      variables: {
        id: `gid://shopify/ProductVariant/${variant}`
      },
    }),
  });

  const txt = await r.text();
  let json;
  try { json = JSON.parse(txt); } catch { return res.send(txt); }

  res.json(json.data);
};
