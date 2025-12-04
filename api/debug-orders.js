const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

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

    const data = await response.json();

    return res.status(200).json({
      ok: true,
      domain,
      apiVersion,
      result: data,
      note: "If count > 0, next we test full order fetch."
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.toString()
    });
  }
}
