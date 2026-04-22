import { Request, Response, NextFunction } from 'express';

// Global hata yakalama middleware'i — hata detayları client'a sızdırılmaz
export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Tam hata sadece server loguna yazılır
  console.error('API Error:', err);
  res.status(500).json({ error: 'Sunucu hatası' });
}
