import express from 'express';

const router = express.Router();

router.get('/dashboard', (req, res) => {
  res.json({ message: 'Admin dashboard - route stub' });
});

router.get('/users', (req, res) => {
  res.json({ message: 'Get users - route stub' });
});

router.get('/payments', (req, res) => {
  res.json({ message: 'Get payments - route stub' });
});

export default router;
