import { Router } from 'express';

import authRoutes from './authRoutes.js';
import chatRoutes from './chatRoutes.js';
import conversationRoutes from './conversationRoutes.js';
import documentRoutes from './documentRoutes.js';
import userRoutes from './userRoutes.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/chat', chatRoutes);
router.use('/conversations', conversationRoutes);
router.use('/documents', documentRoutes);
router.use('/user', userRoutes);

export default router;
