import { Router } from 'express';

import authController from '../controllers/authController.js';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import rateLimit from '../middleware/rateLimit.js';

const router = Router();

router.get('/config', authController.authConfig);

// Auth endpoints are limited by IP: an attacker is not authenticated yet.
router.post('/signup', rateLimit({ name: 'signup', by: 'ip' }), asyncHandler(authController.signup));
router.post('/login', rateLimit({ name: 'login', by: 'ip' }), asyncHandler(authController.login));
router.post('/logout', asyncHandler(authController.logout));
router.get('/me', requireAuth, asyncHandler(authController.me));

router.get('/google', rateLimit({ name: 'oauth', by: 'ip' }), asyncHandler(authController.googleStart));
router.get('/google/callback', asyncHandler(authController.googleCallback));

export default router;
