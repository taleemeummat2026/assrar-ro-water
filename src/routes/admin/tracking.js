/** Super Admin "Live tracking": where every delivery boy is now and the path he took on a day. */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin } from '../../lib/auth.js';
import { todayISO } from '../../lib/dates.js';
import { notFound, parse, zDate } from '../../lib/http.js';
import { liveView, trail } from '../../services/tracking.js';

export const trackingRouter = Router();
// Staff locations are personal data: Owner and Manager only (not Accounts).
trackingRouter.use(requireAdmin('manager'));

trackingRouter.get('/live', async (_req, res) => {
  res.json(await liveView());
});

trackingRouter.get('/:boyId/trail', async (req, res) => {
  const { date = todayISO() } = parse(z.object({ date: zDate.optional() }), req.query);
  const result = await trail(req.params.boyId, date);
  if (!result) throw notFound('Delivery boy not found');
  res.json(result);
});
