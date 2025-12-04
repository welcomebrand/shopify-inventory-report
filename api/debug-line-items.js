export default async function handler(req, res) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';

  try {
    const url = `https://${domain}/admin/api/${apiVersion}/orders.json?status=any&limit=50&fields=id,line_items`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    const mapped = data.orders.map(o => ({
      order_id: o.id,
      items: o.line_items.map(li => ({
        variant_id: li.variant_id,
        sku: li.sku,
        qty: li.quantity
      }))
    }));

    return res.status(200).json({
      ok: true,
      count: mapped.length,
      sample: mapped
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.toString()
    });
  }
}
