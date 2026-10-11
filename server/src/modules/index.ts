import type { FastifyInstance } from 'fastify';
import authRoutes from './auth/routes';
import deviceRoutes from './devices/routes';
import menuRoutes from './menu/routes';
import orderRoutes from './orders/routes';
import paymentRoutes from './payments/routes';
import settingsRoutes from './settings/routes';
import realtimeRoutes from './realtime/routes';
import tableRoutes from './tables/routes';
import userRoutes from './users/routes';

/** Every API module is registered here under the /api prefix. */
export async function registerModules(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(deviceRoutes);
  await app.register(menuRoutes);
  await app.register(tableRoutes);
  await app.register(orderRoutes);
  await app.register(paymentRoutes);
  await app.register(settingsRoutes);
  await app.register(realtimeRoutes);
}
