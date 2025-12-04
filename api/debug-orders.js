export default async function handler(req, res) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2024-10';

  if (!domain || !token) {
    return res.status(400).json({
      ok: false,
      error: 'Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_API_ACCESS_TOKEN'
    });
  }

  try {
    const url = `https://${domain}/admin/api/${apiVersion}/orders/count.json?status=any`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        ok: false,
        response_error: text,
        status: response.status
      });
    }

    const data = await response.json();

    return res.status(200).json({
      ok: true,
      domain,
      apiVersion,
      result: data,
      note: "If count > 0, we can proceed to full order pull"
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.toString()
    });
  }
}
