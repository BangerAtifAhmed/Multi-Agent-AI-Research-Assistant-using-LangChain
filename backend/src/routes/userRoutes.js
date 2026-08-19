import { Router } from 'express';

import userController from '../controllers/userController.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(userController.profile));
router.patch('/', asyncHandler(userController.updateProfile));
router.post('/logout-all', asyncHandler(userController.logoutEverywhere));

export default router;
