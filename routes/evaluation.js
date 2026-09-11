import express from 'express';

const router = express.Router();

router.get('/:resultId', (req, res) => {
  res.json({ message: 'Get evaluation - route stub' });
});

router.post('/:resultId/appeal', (req, res) => {
  res.json({ message: 'Appeal evaluation - route stub' });
});

export default router;
