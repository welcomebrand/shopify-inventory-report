module.exports = async (req, res) => {
  res.status(200).json({
    domain: process.env.SHOPIFY_STORE_DOMAIN,
    token_present: !!process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    api_version: process.env.SHOPIFY_API_VERSION,
  });
};
