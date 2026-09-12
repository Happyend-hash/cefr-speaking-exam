/**
 * 404 Not Found Error Handler
 */
export const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  res.status(404);
  next(error);
};

/**
 * Global Error Handler
 */
export const errorHandler = (error, req, res, next) => {
  // Prefer the status the error itself carries. Reading only res.statusCode meant
  // every APIError — 400 validation, 403 ownership, 404 not-found — was reported
  // as a 500, because the response status is still 200 when the error is thrown.
  // Mongoose validation and cast failures are client errors too, not server faults.
  let statusCode = error.statusCode;

  if (!statusCode) {
    if (error.name === 'ValidationError' || error.name === 'CastError') statusCode = 400;
    else statusCode = res.statusCode === 200 ? 500 : res.statusCode;
  }

  // Log error in production
  if (process.env.NODE_ENV === 'production') {
    console.error('Error:', {
      message: error.message,
      stack: error.stack,
      path: req.path,
      method: req.method,
      timestamp: new Date().toISOString()
    });
  }

  res.status(statusCode).json({
    success: false,
    message: error.message,
    ...(process.env.NODE_ENV === 'development' && {
      stack: error.stack,
      details: error
    })
  });
};

/**
 * Custom API Error Class
 */
export class APIError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'APIError';
  }
}

/**
 * Validation Error Class
 */
export class ValidationError extends APIError {
  constructor(message, details = {}) {
    super(message, 400);
    this.details = details;
    this.name = 'ValidationError';
  }
}

/**
 * Authentication Error Class
 */
export class AuthenticationError extends APIError {
  constructor(message = 'Authentication failed') {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

/**
 * Authorization Error Class
 */
export class AuthorizationError extends APIError {
  constructor(message = 'Not authorized') {
    super(message, 403);
    this.name = 'AuthorizationError';
  }
}
