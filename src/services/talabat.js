const axios = require('axios');

let token = null;
let tokenExpiry = 0;

const BASE_URL = process.env.TALABAT_API_URL || 'https://talabat.partner.deliveryhero.io';
const IAM_URL = 'https://iam-core.deliveryhero.io/connect/token';

async function getToken() {
  if (token && Date.now() < tokenExpiry) return token;

  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', process.env.TALABAT_CLIENT_ID);
  params.append('client_secret', process.env.TALABAT_CLIENT_SECRET);

  const res = await axios.post(IAM_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + 1.8 * 60 * 60 * 1000;
  return token;
}

async function getOrderDetails(orderId) {
  const t = await getToken();
  const res = await axios.get(`${BASE_URL}/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${t}` }
  });
  return res.data;
}

async function updateOrderStatus(talabatOrderId, status) {
  if (!process.env.TALABAT_CLIENT_ID) return;
  try {
    const t = await getToken();
    await axios.patch(
      `${BASE_URL}/orders/${talabatOrderId}/status`,
      { status },
      { headers: { Authorization: `Bearer ${t}` } }
    );
  } catch (e) {
    console.error('Talabat status update failed:', e.message);
  }
}

async function pushDriverLocation(talabatOrderId, lat, lng) {
  if (!process.env.TALABAT_CLIENT_ID) return;
  try {
    const t = await getToken();
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
