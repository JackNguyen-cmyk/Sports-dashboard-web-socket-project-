import { MATCH_STATUS } from '../validation/matches.js';

export function getMatchStatus(startTime, endTime, now = new Date()) {
    const start = new Date(startTime);

    if (Number.isNaN(start.getTime())) {
        return null;
    }

    if (now < start) {
        return MATCH_STATUS.SCHEDULED;
    }

    // No end time recorded yet, so the match cannot be known to have ended.
    // Note: `new Date(null)` is the Unix epoch, not an invalid date, so the
    // absent case must be handled before `endTime` is ever parsed.
    if (endTime === null || endTime === undefined) {
        return MATCH_STATUS.LIVE;
    }

    const end = new Date(endTime);

    if (Number.isNaN(end.getTime())) {
        return null;
    }

    if (now >= end) {
        return MATCH_STATUS.FINISHED;
    }

    return MATCH_STATUS.LIVE;
}

export async function syncMatchStatus(match, updateStatus) {
    const nextStatus = getMatchStatus(match.startTime, match.endTime);
    if (!nextStatus) {
        return match.status;
    }
    if (match.status !== nextStatus) {
        await updateStatus(nextStatus);
        match.status = nextStatus;
    }
    return match.status;
}