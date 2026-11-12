/**
 * SMS sending. The SMS company is chosen later (billed separately per the quotation), so this works with
 * any provider that has an HTTP API:
 *
 *   SMS_PROVIDER=http
 *   SMS_URL_TEMPLATE=https://sms.example.com/api/send?key=XXXX&to={mobile}&text={message}
 *
 * {mobile} is the 10-digit number, {message} is URL-encoded. With SMS_PROVIDER=console (default)
 * messages are only printed in the server log.
 */
import { config } from '../config.js';

export async function sendSms(mobile, message) {
  if (config.sms.provider !== 'http' || !config.sms.urlTemplate) {
    console.log(`[sms → ${mobile}] ${message}`);
    return true;
  }
  const url = config.sms.urlTemplate.replace('{mobile}', encodeURIComponent(mobile)).replace('{message}', encodeURIComponent(message));
  try {
    const res = await fetch(url, { method: config.sms.method, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) console.error(`[sms] provider answered ${res.status} for ${mobile}`);
    return res.ok;
  } catch (e) {
    console.error('[sms] could not reach provider:', e.message);
    return false;
  }
}
