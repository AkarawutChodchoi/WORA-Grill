import type { FastifyInstance } from 'fastify';
import authRoutes from './auth/routes';
import deviceRoutes from './devices/routes';
import userRoutes from './users/routes';

/** Every API module is registered here under the /api prefix. */
export async function registerModules(app: FastifyInstance) {
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(deviceRoutes);
}
