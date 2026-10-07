const axios = require('axios');

// Per-chain token cache: { [clientId]: { token, expiry } }
const tokenCache = {};

const BASE_URL = process.env.TALABAT_API_URL || 'https://talabat.partner.deliveryhero.io';
const IAM_URL = 'https://iam-core.deliveryhero.io/connect/token';

async function getToken(clientId, clientSecret) {
  const cached = tokenCache[clientId];
  if (cached && Date.now() < cached.expiry) return cached.token;

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  const res = await axios.post(IAM_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  tokenCache[clientId] = {
    token: res.data.access_token,
    expiry: Date.now() + 1.8 * 60 * 60 * 1000
  };
  return tokenCache[clientId].token;
}

// Returns [clientId, clientSecret] using chain credentials or fallback to env vars
function resolveCredentials(chainClientId, chainClientSecret) {
  const clientId = chainClientId || process.env.TALABAT_CLIENT_ID;
  const clientSecret = chainClientSecret || process.env.TALABAT_CLIENT_SECRET;
  return [clientId, clientSecret];
}

async function getOrderDetails(orderId, chainClientId, chainClientSecret) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId) return null;
  const t = await getToken(clientId, clientSecret);
  const res = await axios.get(`${BASE_URL}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${t}` }
  });
  return res.data;
}

async function updateOrderStatus(talabatOrderId, status, chainClientId, chainClientSecret) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId) return;
  try {
    const t = await getToken(clientId, clientSecret);
    await axios.patch(
      `${BASE_URL}/orders/${talabatOrderId}/status`,
      { status },
      { headers: { Authorization: `Bearer ${t}` } }
    );
  } catch (e) {
    console.error('Talabat status update failed:', e.message);
  }
}

async function pushDriverLocation(talabatOrderId, lat, lng, chainClientId, chainClientSecret) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId) return;
  try {
    const t = await getToken(clientId, clientSecret);
    await axios.post(
      `${BASE_URL}/orders/${talabatOrderId}/driver-location`,
      { latitude: lat, longitude: lng },
      { headers: { Authorization: `Bearer ${t}` } }
    );
  } catch (e) {
    console.error('Talabat location push failed:', e.message);
  }
}

module.exports = { getOrderDetails, updateOrderStatus, pushDriverLocation };
