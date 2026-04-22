import { Request, Response, NextFunction } from 'express';

// Global hata yakalama middleware'i
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error('API Error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
}
