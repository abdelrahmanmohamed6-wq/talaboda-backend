const axios = require('axios');

let token = null;
let tokenExpiry = 0;

async function getToken() {
  if (token && Date.now() < tokenExpiry) return token;

  const res = await axios.post(`${process.env.TALABAT_API_URL}/oauth/token`, {
    client_id: process.env.TALABAT_CLIENT_ID,
    client_secret: process.env.TALABAT_CLIENT_SECRET,
    grant_type: 'client_credentials'
  });

  token = res.data.access_token;
  tokenExpiry = Date.now() + 1.8 * 60 * 60 * 1000; // refresh before 2hr expiry
  return token;
}

async function updateOrderStatus(talabatOrderId, status) {
  if (!process.env.TALABAT_CLIENT_ID) return;
  try {
    const t = await getToken();
    await axios.patch(
      `${process.env.TALABAT_API_URL}/orders/${talabatOrderId}/status`,
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
      `${process.env.TALABAT_API_URL}/orders/${talabatOrderId}/driver-location`,
      { latitude: lat, longitude: lng },
      { headers: { Authorization: `Bearer ${t}` } }
    );
  } catch (e) {
    console.error('Talabat location push failed:', e.message);
  }
}

module.exports = { updateOrderStatus, pushDriverLocation };
