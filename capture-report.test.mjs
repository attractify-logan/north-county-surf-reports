import assert from 'node:assert/strict';
import test from 'node:test';
import { parseReport } from './capture-report.mjs';

const capture = '2026-09-06T14:35:15Z';
const report = (date, conditions) => `Oceanside Surf Report was recorded on ${date}. ${conditions}`;

test('preserves a stale spoken date and distinguishes surf from tide and wind numbers', () => {
  const result = parseReport('oceanside', report('Saturday, September 5 at 8AM',
    "Under clear skies, there's a three to five foot South Southwest swell with fair shape. Water temperature is 73 degrees. There's a three mile per hour wind. Today's tides include a low of 3.2 at 10:05AM, rising to a high of 5.5 at 04:48PM."), capture);
  assert.equal(result.reported_date, '2026-09-05');
  assert.deepEqual(result.surf_ft, [3, 5]);
  assert.equal(result.reported_date_year_inferred, true);
});

test('resolves year rollover but leaves contradictory or impossible dates unconfirmed', () => {
  assert.equal(parseReport('oceanside', report('Wednesday, December 31 at 8AM', 'Surf is 2–4 feet.'), '2026-01-01T16:00:00Z').reported_date, '2025-12-31');
  assert.equal(parseReport('oceanside', report('Monday, September 5 at 8AM', 'Surf is 2–4 feet.'), capture).reported_date, null);
  assert.equal(parseReport('oceanside', report('February 30 at 8AM', 'Surf is 2–4 feet.'), capture).reported_date, null);
  assert.equal(parseReport('oceanside', report('September 7, 2026 at 8AM', 'Surf is 2–4 feet.'), capture).reported_date, null);
  assert.equal(parseReport('oceanside', report('this morning', 'Surf is 2–4 feet.'), capture).reported_date, null);
});

test('does not invent wave heights from tides or choose between competing swell ranges', () => {
  assert.equal(parseReport('oceanside', report('September 6', 'The surf is flat. Tides range from one to three feet.'), capture).surf_ft, null);
  assert.equal(parseReport('oceanside', report('September 6', 'The surf is flat, with tides from one to three feet.'), capture).surf_ft, null);
  assert.equal(parseReport('oceanside', report('September 6', 'The south swell is 3–5 feet. The northwest swell is 2–4 feet.'), capture).surf_ft, null);
  assert.deepEqual(parseReport('oceanside', report('September 6', 'Surf is 2.5–4.5 feet.'), capture).surf_ft, [2.5, 4.5]);
});

test('rejects the phone menu instead of publishing it as a captured report', () => {
  assert.throws(() => parseReport('oceanside', 'Thank you for calling Oceanside. For the weather and surf report, press 1.', capture));
});

test('parses Del Mar spoken ordinal dates without mistaking tides for surf', () => {
  const transcript = 'Good morning. This is Delmar surf and weather report for Saturday morning, September fifth. Air temperature is 77. The water is 72. Winds are relatively calm. Surf height is three to four feet. Air form, eleven second interval out of the Southwest. Low tide this morning at 10:05AM, 3.2 feet, rising to a high of 5.5 at 04:48PM. Rip current strength is moderate to strong.';
  const result = parseReport('del-mar', transcript, capture);
  assert.equal(result.reported_date, '2026-09-05');
  assert.deepEqual(result.surf_ft, [3, 4]);
  assert.equal(parseReport('del-mar', transcript.replace('Saturday morning, September fifth', 'Friday morning, September fifth'), capture).reported_date, null);
  assert.equal(parseReport('del-mar', transcript.replace('Saturday morning, September fifth', 'Monday morning, August thirty first'), capture).reported_date, '2026-08-31');
});

test('rejects mismatched sources and discontinued recordings', () => {
  assert.throws(() => parseReport('del-mar', report('September 6', 'Surf is 3–5 feet.'), capture));
  assert.throws(() => parseReport('del-mar', 'The Del Mar surf and weather report for today has been discontinued.', capture));
  assert.throws(() => parseReport('encinitas', 'Thank you for calling Encinitas Lifeguards. The beach weather and surf report recording has been discontinued.', capture));
});
