import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const hotlines = {
  oceanside: { location: 'Oceanside', phone: '+17604354020', name: /\bOceanside\b/i, digits: 'WWWWWWWWWW1' },
  'del-mar': { location: 'Del Mar', phone: '+18582598208', name: /\bDel\s*Mar\b/i },
};
const months = 'January February March April May June July August September October November December'.split(' ');
const weekdays = 'Sunday Monday Tuesday Wednesday Thursday Friday Saturday'.split(' ');
const numbers = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
const ordinalDays = 'first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth twenty-first twenty-second twenty-third twenty-fourth twenty-fifth twenty-sixth twenty-seventh twenty-eighth twenty-ninth thirtieth thirty-first'.split(' ');

export function parseReport(sourceID, transcript, capturedAt) {
  const source = hotlines[sourceID];
  if (!source) throw new Error('Unknown public report source.');
  const captured = new Date(capturedAt);
  if (!Number.isFinite(captured.getTime()) || typeof transcript !== 'string' || transcript.length > 12000 ||
      !source.name.test(transcript) || !/\bsurf(?: and weather)? report\b.{0,30}(?:recorded on|for)\b/i.test(transcript) ||
      /\bdiscontinued\b/i.test(transcript)) {
    throw new Error(`No usable ${source.location} report: the recording may contain only the phone menu.`);
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(captured);
  const part = name => parts.find(p => p.type === name).value;
  const captureDay = `${part('year')}-${part('month')}-${part('day')}`;
  const announced = transcript.match(new RegExp(
    `(?:recorded on|report for)\\s+(?:(${weekdays.join('|')})(?:\\s+(?:morning|afternoon|evening))?,?\\s+)?(${months.join('|')})\\s+(\\d{1,2}|${ordinalDays.join('|').replaceAll('-', '[- ]')})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, 'i',
  ));
  let reportedDate = null;
  if (announced) {
    const [, weekday, month, day, explicitYear] = announced;
    const monthIndex = months.findIndex(m => m.toLowerCase() === month.toLowerCase());
    const dayNumber = /^\d/.test(day) ? Number(day) : ordinalDays.indexOf(day.toLowerCase().replaceAll(' ', '-')) + 1;
    let year = Number(explicitYear ?? part('year'));
    let date = new Date(Date.UTC(year, monthIndex, dayNumber));
    if (!explicitYear && date.toISOString().slice(0, 10) > captureDay) {
      date = new Date(Date.UTC(--year, monthIndex, dayNumber));
    }
    const isoDay = date.toISOString().slice(0, 10);
    if (date.getUTCMonth() === monthIndex && date.getUTCDate() === dayNumber &&
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
    if (!/\b(?:surf|swell|waves?)\b/i.test(sentence) || /\btides?\b/i.test(sentence)) continue;
    for (const match of sentence.matchAll(pattern)) {
      const range = [value(match[1]), value(match[2])];
      if (range.every(Number.isFinite) && range[0] >= 0 && range[0] <= range[1] &&
          !ranges.some(previous => previous[0] === range[0] && previous[1] === range[1])) {
        ranges.push(range);
      }
    }
  }
  return {
    location: source.location, captured_at: captured.toISOString(), reported_date: reportedDate,
    surf_ft: ranges.length === 1 ? ranges[0] : null, transcript,
    source_phone: source.phone, transcription_provider: 'Deepgram nova-3',
    reported_date_year_inferred: reportedDate !== null && !announced[4],
  };
}

async function collect(sourceID, recordingSID) {
  const source = hotlines[sourceID];
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
      To: source.phone, From: callers.outgoing_caller_ids[0].phone_number,
      ...(source.digits ? { SendDigits: source.digits } : {}),
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
  if (call.to !== source.phone || call.direction !== 'outbound-api' || recording.status !== 'completed' ||
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
  return parseReport(sourceID, result.results?.channels?.[0]?.alternatives?.[0]?.transcript, recording.start_time);
}

// Local: node --env-file=/path/to/managed.env capture-report.mjs [--source del-mar --recording-sid RE...] [--output site/report.json]
if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      source: { type: 'string' }, 'recording-sid': { type: 'string' },
      output: { type: 'string', default: 'site/report.json' },
    } });
    if (values.source && !Object.hasOwn(hotlines, values.source)) throw new Error('Unknown public report source.');
    if (values['recording-sid'] && !values.source) throw new Error('A recording identifier requires --source.');
    const sources = values.source ? [values.source] : Object.keys(hotlines);
    const reports = await Promise.all(sources.map(async sourceID => {
      try {
        const report = await collect(sourceID, values['recording-sid']);
        console.log(`${report.location}: spoken date ${report.reported_date ?? 'unconfirmed'}, wave range ${report.surf_ft?.join('–') ?? 'unparsed'} ft.`);
        return report;
      } catch (error) {
        console.error(`${hotlines[sourceID].location}: ${error.message}`);
        return {
          location: hotlines[sourceID].location, source_phone: hotlines[sourceID].phone,
          captured_at: null, reported_date: null, surf_ft: null, transcript: null, issue: error.message,
        };
      }
    }));
    if (reports.every(report => report.issue)) throw new Error('No public surf reports could be collected.');
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, JSON.stringify(reports, null, 2) + '\n');
    console.log(`Saved ${reports.filter(report => !report.issue).length} of ${reports.length} regional reports.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
