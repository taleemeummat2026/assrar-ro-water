/** Simple per-IP limit for login / OTP / public forms (stops someone hammering the SMS gateway). */
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.reset < now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const v = hits.get(key);
    if (!v || v.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++v.count > max) return res.status(429).json({ message: 'Too many attempts. Please wait a minute and try again.' });
    next();
  };
}
