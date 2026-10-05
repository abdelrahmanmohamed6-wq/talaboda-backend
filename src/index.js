require('dotenv').config();
require('express-async-errors');
const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const { initSocket } = require('./socket');

const authRoutes = require('./routes/auth');
const driversRoutes = require('./routes/drivers');
const ordersRoutes = require('./routes/orders');
const branchesRoutes = require('./routes/branches');
const webhookRoutes = require('./routes/webhook');
const shiftsRoutes = require('./routes/shifts');
const supportRoutes = require('./routes/support');
const chainsRoutes = require('./routes/chains');

const app = express();
const httpServer = createServer(app);

initSocket(httpServer);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/drivers', driversRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/branches', branchesRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/chains', chainsRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
