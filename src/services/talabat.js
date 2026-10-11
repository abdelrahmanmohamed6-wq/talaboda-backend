const axios = require('axios');

const BASE = 'https://talabat.partner.deliveryhero.io';
const TOKEN_URL = `${BASE}/v2/oauth/token`;

// Per-clientId token cache
const tokenCache = {};

async function getToken(clientId, clientSecret) {
  const cached = tokenCache[clientId];
  if (cached && Date.now() < cached.expiry) return cached.token;

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);

  const res = await axios.post(TOKEN_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  // Cache with 60s buffer before expiry
  tokenCache[clientId] = {
    token: res.data.access_token,
    expiry: Date.now() + (res.data.expires_in - 60) * 1000
  };
  return tokenCache[clientId].token;
}

function resolveCredentials(chainClientId, chainClientSecret) {
  return [
    chainClientId || process.env.TALABAT_CLIENT_ID,
    chainClientSecret || process.env.TALABAT_CLIENT_SECRET
  ];
}

// GET order details from Talabat
async function getOrderDetails(talabatOrderId, chainClientId, chainClientSecret, talabatChainId) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId || !talabatChainId) return null;
  try {
    const token = await getToken(clientId, clientSecret);
    const res = await axios.get(
      `${BASE}/v2/chains/${talabatChainId}/orders/${talabatOrderId}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    return res.data;
  } catch (e) {
    console.error('Talabat getOrder failed:', e.response?.data || e.message);
    return null;
  }
}

// PATCH order — used for UPDATE_CART, READY_FOR_PICKUP, DISPATCHED, CANCELLED
async function updateOrder(talabatOrderId, status, items, chainClientId, chainClientSecret, talabatChainId) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId || !talabatChainId) throw new Error('Missing Talabat credentials or chainId');

  const token = await getToken(clientId, clientSecret);
  const body = { order_id: talabatOrderId, status, items: items || [] };

  const res = await axios.patch(
    `${BASE}/v2/chains/${talabatChainId}/orders/${talabatOrderId}`,
    body,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' } }
  );
  return res.data;
}

// Legacy – kept for backward compat with existing code
async function updateOrderStatus(talabatOrderId, status, chainClientId, chainClientSecret) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId) return;
  try {
    const token = await getToken(clientId, clientSecret);
    await axios.patch(
      `${BASE}/orders/${talabatOrderId}/status`,
      { status },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    console.error('Talabat status update failed:', e.message);
  }
}

async function pushDriverLocation(talabatOrderId, lat, lng, chainClientId, chainClientSecret) {
  const [clientId, clientSecret] = resolveCredentials(chainClientId, chainClientSecret);
  if (!clientId) return;
  try {
    const token = await getToken(clientId, clientSecret);
    await axios.post(
      `${BASE}/orders/${talabatOrderId}/driver-location`,
      { latitude: lat, longitude: lng },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    console.error('Talabat location push failed:', e.message);
  }
}

module.exports = { getToken, getOrderDetails, updateOrder, updateOrderStatus, pushDriverLocation };
