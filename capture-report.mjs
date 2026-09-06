import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const hotline = '+17604354020';
const months = 'January February March April May June July August September October November December'.split(' ');
const weekdays = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');
const numbers = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');

export function parseReport(transcript, capturedAt) {
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime()) || typeof transcript !== 'string' || transcript.length > 12000 ||
      !/Oceanside/i.test(transcript) || !/surf report.{0,20}recorded on/i.test(transcript)) {
    throw new Error('No usable Oceanside report: the recording may contain only the phone menu.');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(captured);
  const part = name => parts.find(p => p.type === name).value;
  const captureDay = `${part('year')}-${part('month')}-${part('day')}`;
  const announced = transcript.match(new RegExp(
    `recorded on\\s+(?:(${weekdays.join('|')}),?\\s+)?(${months.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'i',
  ));
  let reportedDate = null;
  if (announced) {
    const [, weekday, month, day, explicitYear] = announced;
    const monthIndex = months.findIndex(m => m.toLowerCase() === month.toLowerCase());
    let year = Number(explicitYear ?? part('year'));
    let date = new Date(Date.UTC(year, monthIndex, Number(day)));
    if (!explicitYear && date.toISOString().slice(0, 10) > captureDay) {
      date = new Date(Date.UTC(--year, monthIndex, Number(day)));
    }
    const isoDay = date.toISOString().slice(0, 10);
    if (date.getUTCMonth() === monthIndex && date.getUTCDate() === Number(day) &&
        isoDay <= captureDay && (!weekday || weekdays[date.getUTCDay()].toLowerCase() === weekday.toLowerCase())) {
      reportedDate = isoDay;
    }
  }

  // ponytail: recognize explicit wave ranges only; leave unfamiliar or conflicting wording unparsed.
  const number = `(?:\\d+(?:\\.\\d+)?|${numbers.join('|')})`;
  const pattern = new RegExp(`\\b(${number})\\s*(?:to|[-–])\\s*(${number})[-\\s]*(?:feet|foot|ft)\\b`, 'gi');
  const value = text => /^\d/.test(text) ? Number(text) : numbers.indexOf(text.toLowerCase());
  const ranges = [];
  for (const sentence of transcript.split(/(?<=[.!?])\s+/)) {
    if (!/\b(?:surf|swell|waves?)\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(pattern)) {
      const range = [value(match[1]), value(match[2])];
      if (range.every(Number.isFinite) && range[0] >= 0 && range[0] <= range[1] &&
          !ranges.some(previous => previous[0] === range[0] && previous[1] === range[1])) {
        ranges.push(range);
      }
    }
  }
  return {
    location: 'Oceanside', captured_at: captured.toISOString(), reported_date: reportedDate,
    surf_ft: ranges.length === 1 ? ranges[0] : null, transcript,
    source_phone: hotline, transcription_provider: 'Deepgram nova-3',
    reported_date_year_inferred: reportedDate !== null && !announced[4],
  };
}

async function collect(recordingSID) {
  const required = ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'DEEPGRAM_API_KEY'];
  for (const name of required) {
    if (!process.env[name]?.trim()) throw new Error(`Missing ${name}.`);
  }
  const { TWILIO_ACCOUNT_SID: account, TWILIO_API_KEY_SID: key, TWILIO_API_KEY_SECRET: secret } = process.env;
  if (!/^AC[0-9a-f]{32}$/i.test(account) || !/^SK[0-9a-f]{32}$/i.test(key)) {
    throw new Error('Invalid Twilio account or API key identifier.');
  }
  const authorization = `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`;
  async function twilio(path, body) {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: authorization },
      body: body ? new URLSearchParams(body) : undefined, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Twilio returned HTTP ${response.status}.`);
    return response;
  }

  let recording;
  if (recordingSID) {
    if (!/^RE[0-9a-f]{32}$/i.test(recordingSID)) throw new Error('Invalid recording identifier.');
    recording = await (await twilio(`Recordings/${recordingSID}.json`)).json();
  } else {
    const callers = await (await twilio('OutgoingCallerIds.json?PageSize=2')).json();
    if (callers.outgoing_caller_ids?.length !== 1 || callers.next_page_uri) {
      throw new Error('Exactly one verified outgoing caller ID is required for this personal collector.');
    }
    const call = await (await twilio('Calls.json', {
      To: hotline, From: callers.outgoing_caller_ids[0].phone_number,
      SendDigits: 'WWWWWWWWWW1',
      Twiml: '<Response><Pause length="60"/><Pause length="60"/><Pause length="60"/><Hangup/></Response>',
      Record: 'true', RecordingTrack: 'inbound', Timeout: '20', TimeLimit: '180',
    })).json();
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      await sleep(5000);
      const state = await (await twilio(`Calls/${call.sid}.json`)).json();
      if (['busy', 'failed', 'no-answer', 'canceled'].includes(state.status)) {
        throw new Error(`Hotline call ended with status ${state.status}.`);
      }
      if (state.status !== 'completed') continue;
      const result = await (await twilio(`Calls/${call.sid}/Recordings.json`)).json();
      recording = result.recordings?.find(item => item.status === 'completed');
      if (recording) break;
    }
    if (!recording) throw new Error('Timed out waiting for the bounded hotline recording.');
  }
  const call = await (await twilio(`Calls/${recording.call_sid}.json`)).json();
  if (call.to !== hotline || call.direction !== 'outbound-api' || recording.status !== 'completed' ||
      Number(recording.duration) < 10 || Number(recording.duration) > 185 || recording.channels !== 1) {
    throw new Error('Refusing to publish audio that is not a completed, bounded call to the public hotline.');
  }
  const audio = await (await twilio(`Recordings/${recording.sid}.wav`)).arrayBuffer();
  const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true', {
    method: 'POST', headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
    body: audio, signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Deepgram returned HTTP ${response.status}.`);
  const result = await response.json();
  return parseReport(result.results?.channels?.[0]?.alternatives?.[0]?.transcript, recording.start_time);
}

// Local: node --env-file=/path/to/managed.env capture-report.mjs [--recording-sid RE...] [--output site/report.json]
if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      'recording-sid': { type: 'string' }, output: { type: 'string', default: 'site/report.json' },
    } });
    const report = await collect(values['recording-sid']);
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved Oceanside report: spoken date ${report.reported_date ?? 'unconfirmed'}, wave range ${report.surf_ft?.join('–') ?? 'unparsed'} ft.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
