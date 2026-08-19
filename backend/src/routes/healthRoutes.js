import { Router } from 'express';

import healthController from '../controllers/healthController.js';
import asyncHandler from '../middleware/asyncHandler.js';

/**
 * Mounted before the global rate limiter so container probes can never be
 * throttled into reporting a false failure.
 */
const router = Router();

router.get('/', asyncHandler(healthController.health));
router.get('/live', healthController.live);
router.get('/ready', asyncHandler(healthController.ready));

export default router;
