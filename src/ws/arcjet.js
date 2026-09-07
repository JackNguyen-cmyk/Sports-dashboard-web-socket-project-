// dotenv must load before this module reads process.env: config is evaluated
// at import time, so a later dotenv call would leave arcjetKey undefined.
import 'dotenv/config';
import arcjet, { detectBot, shield, slidingWindow } from '@arcjet/node';

const arcjetKey = process.env.ARCJET_KEY;

// LIVE enforces rules; DRY_RUN evaluates and logs them but never blocks -
// the safe way to watch what a rule *would* do before enforcing it.
const arcjetMode = process.env.ARCJET_MODE === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE';

const isDevelopment = process.env.ARCJET_ENV === 'development';

// No key means protection is simply off, rather than the process refusing to
// boot. Tests and local runs start the app without one; the middleware and
// upgrade handler both null-check before calling protect().
if (!arcjetKey) {
  console.warn('ARCJET_KEY is not set - Arcjet protection is disabled.');
}

// `allow` is an allow-list: anything Arcjet classifies as a bot and that is
// not listed gets denied. curl and Postman are correctly identified as
// automated clients, so without this the API cannot be exercised by hand.
// Allowing them in production would defeat bot detection, hence dev-only.
const allowedBots = isDevelopment
  ? ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW', 'CURL', 'POSTMAN']
  : ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'];

export const httpArcjet = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        shield({ mode: arcjetMode }),
        detectBot({ mode: arcjetMode, allow: allowedBots }),
        slidingWindow({ mode: arcjetMode, interval: '10s', max: 50 }),
      ],
    })
  : null;

export const wsArcjet = arcjetKey
  ? arcjet({
      key: arcjetKey,
      rules: [
        shield({ mode: arcjetMode }),
        detectBot({ mode: arcjetMode, allow: allowedBots }),
        // Stricter than HTTP: each upgrade opens a long-lived connection, so
        // a burst of them costs far more than a burst of one-off requests.
        slidingWindow({ mode: arcjetMode, interval: '2s', max: 5 }),
      ],
    })
  : null;

export function securityMiddleware(){
    return async (req, res, next) => {
        if (!httpArcjet) return next();

        try{
            const decision = await httpArcjet.protect( req);

            if (decision.isDenied()) {
                if (decision.reason.isRateLimit()) {
                    return res.status(429).json({ error: "Too many requests" });
                }
                if (decision.reason.isBot()) {
                    return res.status(403).json({ error: "Automated traffic is not allowed" });
                }
                return res.status(403).json({ error: "Forbidden" });
            }

        } catch (error) {
            // Fails OPEN, unlike the WebSocket path which fails closed. An
            // HTTP request that slips through is over in milliseconds, so an
            // outage at Arcjet should not take the whole API down with it.
            // Flip to a 503 here if rejecting unvetted traffic matters more
            // than staying up.
            console.error("arcjet middleware failed, allowing request", error);
        }

        next();
    };
}
