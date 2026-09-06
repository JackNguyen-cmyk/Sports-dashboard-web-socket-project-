import test from 'node:test';
import assert from 'node:assert/strict';

import { getMatchStatus, syncMatchStatus } from './match-status.js';
import { MATCH_STATUS } from '../validation/matches.js';

const START = '2026-09-10T14:00:00Z';
const END = '2026-09-10T16:00:00Z';
const at = (iso) => new Date(iso);

test('getMatchStatus: before kickoff is scheduled', () => {
    assert.equal(
        getMatchStatus(START, END, at('2026-09-10T13:59:59Z')),
        MATCH_STATUS.SCHEDULED,
    );
});

test('getMatchStatus: between kickoff and end is live', () => {
    assert.equal(
        getMatchStatus(START, END, at('2026-09-10T15:00:00Z')),
        MATCH_STATUS.LIVE,
    );
});

test('getMatchStatus: exactly at kickoff is live', () => {
    assert.equal(getMatchStatus(START, END, at(START)), MATCH_STATUS.LIVE);
});

test('getMatchStatus: exactly at end is finished', () => {
    assert.equal(getMatchStatus(START, END, at(END)), MATCH_STATUS.FINISHED);
});

test('getMatchStatus: after end is finished', () => {
    assert.equal(
        getMatchStatus(START, END, at('2026-09-10T18:00:00Z')),
        MATCH_STATUS.FINISHED,
    );
});

// Regression: end_time is nullable, so Drizzle hands back null for a match
// that has not finished. `new Date(null)` is the Unix epoch, not an invalid
// date, which previously made every such match report as finished.
test('getMatchStatus: null endTime before kickoff is scheduled', () => {
    assert.equal(
        getMatchStatus(START, null, at('2026-09-10T13:00:00Z')),
        MATCH_STATUS.SCHEDULED,
    );
});

test('getMatchStatus: null endTime after kickoff is live, not finished', () => {
    assert.equal(
        getMatchStatus(START, null, at('2026-09-10T15:00:00Z')),
        MATCH_STATUS.LIVE,
    );
});

test('getMatchStatus: undefined endTime before kickoff is scheduled', () => {
    assert.equal(
        getMatchStatus(START, undefined, at('2026-09-10T13:00:00Z')),
        MATCH_STATUS.SCHEDULED,
    );
});

test('getMatchStatus: undefined endTime after kickoff is live', () => {
    assert.equal(
        getMatchStatus(START, undefined, at('2026-09-10T15:00:00Z')),
        MATCH_STATUS.LIVE,
    );
});

test('getMatchStatus: a long-running match with no end stays live', () => {
    assert.equal(
        getMatchStatus(START, null, at('2030-01-01T00:00:00Z')),
        MATCH_STATUS.LIVE,
    );
});

test('getMatchStatus: invalid startTime returns null', () => {
    assert.equal(getMatchStatus('not-a-date', END, at(START)), null);
});

test('getMatchStatus: present but invalid endTime returns null', () => {
    assert.equal(getMatchStatus(START, 'not-a-date', at(START)), null);
});

test('getMatchStatus: accepts Date objects', () => {
    assert.equal(
        getMatchStatus(at(START), at(END), at('2026-09-10T15:00:00Z')),
        MATCH_STATUS.LIVE,
    );
});

const past = '2020-01-01T00:00:00Z';
const future = '2030-01-01T00:00:00Z';

test('syncMatchStatus: persists and returns the new status on change', async () => {
    const calls = [];
    const match = { startTime: past, endTime: future, status: MATCH_STATUS.SCHEDULED };

    const result = await syncMatchStatus(match, async (s) => calls.push(s));

    assert.equal(result, MATCH_STATUS.LIVE);
    assert.equal(match.status, MATCH_STATUS.LIVE);
    assert.deepEqual(calls, [MATCH_STATUS.LIVE]);
});

test('syncMatchStatus: does not persist when status is unchanged', async () => {
    const calls = [];
    const match = { startTime: past, endTime: future, status: MATCH_STATUS.LIVE };

    const result = await syncMatchStatus(match, async (s) => calls.push(s));

    assert.equal(result, MATCH_STATUS.LIVE);
    assert.deepEqual(calls, []);
});

// Regression: this previously wrote 'finished' to the database for any
// started match whose end time was not yet known.
test('syncMatchStatus: null endTime never persists finished', async () => {
    const calls = [];
    const match = { startTime: past, endTime: null, status: MATCH_STATUS.SCHEDULED };

    const result = await syncMatchStatus(match, async (s) => calls.push(s));

    assert.equal(result, MATCH_STATUS.LIVE);
    assert.ok(!calls.includes(MATCH_STATUS.FINISHED));
    assert.deepEqual(calls, [MATCH_STATUS.LIVE]);
});

test('syncMatchStatus: keeps existing status when times are unparseable', async () => {
    const calls = [];
    const match = { startTime: 'nonsense', endTime: null, status: MATCH_STATUS.SCHEDULED };

    const result = await syncMatchStatus(match, async (s) => calls.push(s));

    assert.equal(result, MATCH_STATUS.SCHEDULED);
    assert.deepEqual(calls, []);
});

test('syncMatchStatus: marks a concluded match finished', async () => {
    const calls = [];
    const match = { startTime: past, endTime: '2020-01-01T02:00:00Z', status: MATCH_STATUS.LIVE };

    const result = await syncMatchStatus(match, async (s) => calls.push(s));

    assert.equal(result, MATCH_STATUS.FINISHED);
    assert.deepEqual(calls, [MATCH_STATUS.FINISHED]);
});
