import Stripe from 'stripe';
import Payment from '../models/Payment.js';
import User from '../models/User.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Payment Service - Handles all payment operations with Stripe
 */
class PaymentService {
  /**
   * Create exam purchase payment
   */
  async createExamPayment(userId, amount = 15) {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      // Create Stripe payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: 'usd',
        metadata: {
          userId: userId.toString(),
          type: 'exam'
        }
      });

      // Create payment record
      const payment = new Payment({
        user: userId,
        type: 'exam',
        amount,
        currency: 'USD',
        status: 'pending',
        stripePaymentIntentId: paymentIntent.id,
        description: 'CEFR Speaking Exam - Single Attempt'
      });

      await payment.save();

      return {
        paymentId: payment._id,
        clientSecret: paymentIntent.client_secret,
        amount,
        currency: 'USD'
      };
    } catch (error) {
      console.error('Error creating exam payment:', error);
      throw error;
    }
  }

  /**
   * Create subscription
   */
  async createSubscription(userId, plan, billingCycle = 'monthly') {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const pricing = this.getSubscriptionPricing(plan, billingCycle);

      // Create Stripe payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(pricing.amount * 100),
        currency: 'usd',
        metadata: {
          userId: userId.toString(),
          type: 'subscription',
          plan,
          billingCycle
        }
      });

      // Create payment record
      const payment = new Payment({
        user: userId,
        type: 'subscription',
        amount: pricing.amount,
        currency: 'USD',
        status: 'pending',
        stripePaymentIntentId: paymentIntent.id,
        subscription: {
          plan,
          billingCycle,
          startDate: new Date(),
          examsIncluded: pricing.examsIncluded
        },
        description: `${plan.charAt(0).toUpperCase() + plan.slice(1)} Subscription - ${billingCycle}`
      });

      await payment.save();

      return {
        paymentId: payment._id,
        clientSecret: paymentIntent.client_secret,
        amount: pricing.amount,
        currency: 'USD',
        examsIncluded: pricing.examsIncluded
      };
    } catch (error) {
      console.error('Error creating subscription:', error);
      throw error;
    }
  }

  /**
   * Complete payment after successful Stripe charge
   */
  async completePayment(paymentIntentId, stripeChargeId) {
    try {
      const payment = await Payment.findOne({
        stripePaymentIntentId: paymentIntentId
      });

      if (!payment) throw new Error('Payment not found');

      payment.status = 'completed';
      payment.stripeChargeId = stripeChargeId;
      payment.processedAt = new Date();
      payment.completedAt = new Date();

      await payment.save();

      // Update user subscription if applicable
      if (payment.type === 'subscription') {
        const user = await User.findById(payment.user);
        const endDate = new Date();

        if (payment.subscription.billingCycle === 'monthly') {
          endDate.setMonth(endDate.getMonth() + 1);
        } else if (payment.subscription.billingCycle === 'quarterly') {
          endDate.setMonth(endDate.getMonth() + 3);
        } else if (payment.subscription.billingCycle === 'yearly') {
          endDate.setFullYear(endDate.getFullYear() + 1);
        }

        user.subscription = {
          plan: payment.subscription.plan,
          status: 'active',
          startDate: payment.subscription.startDate,
          endDate,
          examsRemaining: payment.subscription.examsIncluded,
          stripeCustomerId: payment.stripePaymentIntentId
        };

        await user.save();
      } else if (payment.type === 'exam') {
        // Add exam credit
        const user = await User.findById(payment.user);
        user.subscription.examsRemaining += 1;
        await user.save();
      }

      return payment;
    } catch (error) {
      console.error('Error completing payment:', error);
      throw error;
    }
  }

  /**
   * Handle failed payment
   */
  async failPayment(paymentIntentId, errorMessage) {
    try {
      const payment = await Payment.findOne({
        stripePaymentIntentId: paymentIntentId
      });

      if (payment) {
        payment.status = 'failed';
        payment.failureReason = errorMessage;
        payment.retryCount += 1;
        await payment.save();
      }

      return payment;
    } catch (error) {
      console.error('Error failing payment:', error);
      throw error;
    }
  }

  /**
   * Apply discount code
   */
  async applyDiscount(paymentId, discountCode) {
    try {
      const payment = await Payment.findById(paymentId);
      if (!payment) throw new Error('Payment not found');

      // Validate discount code (implement your discount logic)
      const discount = this.validateDiscountCode(discountCode);
      if (!discount) throw new Error('Invalid discount code');

      payment.applyDiscount(discount);
      await payment.save();

      return {
        discountAmount: payment.discount.amount,
        finalAmount: payment.amount - payment.discount.amount
      };
    } catch (error) {
      console.error('Error applying discount:', error);
      throw error;
    }
  }

  /**
   * Request refund
   */
  async requestRefund(paymentId, reason) {
    try {
      const payment = await Payment.findById(paymentId);
      if (!payment) throw new Error('Payment not found');

      if (payment.status !== 'completed') {
        throw new Error('Can only refund completed payments');
      }

      payment.requestRefund(reason);
      await payment.save();

      // Process refund with Stripe
      if (payment.stripeChargeId) {
        const refund = await stripe.refunds.create({
          charge: payment.stripeChargeId,
          reason: 'customer_request',
          metadata: {
            paymentId: paymentId.toString()
          }
        });

        payment.refund.refundStatus = 'completed';
        payment.refund.refundedAmount = refund.amount / 100;
        payment.refundedAt = new Date();
        await payment.save();
      }

      return payment;
    } catch (error) {
      console.error('Error requesting refund:', error);
      throw error;
    }
  }

  /**
   * Get subscription pricing
   */
  getSubscriptionPricing(plan, billingCycle) {
    const pricing = {
      free: { monthly: { amount: 0, examsIncluded: 2 } },
      premium: {
        monthly: { amount: 29.99, examsIncluded: 10 },
        quarterly: { amount: 79.99, examsIncluded: 30 },
        yearly: { amount: 299.99, examsIncluded: 120 }
      },
      enterprise: {
        monthly: { amount: 99.99, examsIncluded: 50 },
        quarterly: { amount: 279.99, examsIncluded: 150 },
        yearly: { amount: 999.99, examsIncluded: 600 }
      }
    };

    return pricing[plan]?.[billingCycle] || { amount: 0, examsIncluded: 0 };
  }

  /**
   * Validate discount code
   */
  validateDiscountCode(code) {
    const discounts = {
      'WELCOME20': { percentage: 20, description: 'Welcome 20% off' },
      'STUDENT15': { percentage: 15, description: 'Student 15% off' },
      'BULK10': { percentage: 10, description: 'Bulk purchase 10% off' }
    };

    return discounts[code] || null;
  }

  /**
   * Get payment history for user
   */
  async getPaymentHistory(userId, limit = 10, skip = 0) {
    try {
      const payments = await Payment.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip);

      const total = await Payment.countDocuments({ user: userId });

      return {
        payments,
        total,
        pages: Math.ceil(total / limit)
      };
    } catch (error) {
      console.error('Error getting payment history:', error);
      throw error;
    }
  }

  /**
   * Generate invoice
   */
  async generateInvoice(paymentId) {
    try {
      const payment = await Payment.findById(paymentId).populate('user');
      if (!payment) throw new Error('Payment not found');

      // Generate invoice number
      payment.invoiceNumber = `INV-${Date.now()}-${payment._id.toString().slice(-8)}`;
      await payment.save();

      return {
        invoiceNumber: payment.invoiceNumber,
        date: payment.completedAt,
        user: {
          name: `${payment.user.firstName} ${payment.user.lastName}`,
          email: payment.user.email
        },
        items: [
          {
            description: payment.description,
            amount: payment.amount
          }
        ],
        subtotal: payment.amount,
        discount: payment.discount?.amount || 0,
        taxes: payment.taxes?.amount || 0,
        total: payment.amount - (payment.discount?.amount || 0) + (payment.taxes?.amount || 0)
      };
    } catch (error) {
      console.error('Error generating invoice:', error);
      throw error;
    }
  }
}

export default new PaymentService();
