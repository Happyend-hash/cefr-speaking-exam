import express from 'express';

const router = express.Router();

router.get('/profile', (req, res) => {
  res.json({ message: 'Get user profile - route stub' });
});

router.put('/profile', (req, res) => {
  res.json({ message: 'Update user profile - route stub' });
});

router.get('/history', (req, res) => {
  res.json({ message: 'Get exam history - route stub' });
});

router.post('/change-password', (req, res) => {
  res.json({ message: 'Change password - route stub' });
});

export default router;
