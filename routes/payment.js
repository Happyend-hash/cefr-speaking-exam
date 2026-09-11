import express from 'express';

const router = express.Router();

router.post('/create-exam-payment', (req, res) => {
  res.json({ message: 'Create exam payment - route stub' });
});

router.post('/create-subscription', (req, res) => {
  res.json({ message: 'Create subscription - route stub' });
});

router.post('/webhook', (req, res) => {
  res.json({ message: 'Stripe webhook - route stub' });
});

export default router;
