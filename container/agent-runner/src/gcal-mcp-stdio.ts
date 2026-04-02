/**
 * Google Calendar MCP Server (stdio transport)
 * Provides calendar read/write operations for NanoClaw container agents.
 *
 * Required env:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 *
 * Uses OAuth2 refresh tokens — no browser flow needed inside containers.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? '';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

let accessToken = '';
let tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  accessToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return accessToken;
}

async function gcalFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) throw new Error(`Google Calendar API error: ${res.status} ${await res.text()}`);
  return res.json();
}

const server = new McpServer({
  name: 'google-calendar',
  version: '1.0.0',
});

server.tool('gcal_list_calendars', 'List all calendars', {}, async () => {
  const data = (await gcalFetch('/users/me/calendarList')) as {
    items: { id: string; summary: string; primary?: boolean }[];
  };
  const calendars = data.items.map((c) => ({
    id: c.id,
    name: c.summary,
    primary: c.primary ?? false,
  }));
  return { content: [{ type: 'text' as const, text: JSON.stringify(calendars, null, 2) }] };
});

server.tool(
  'gcal_list_events',
  'List events from a calendar',
  {
    calendarId: z.string().default('primary').describe('Calendar ID (default: primary)'),
    timeMin: z.string().optional().describe('Start time (ISO 8601). Defaults to now.'),
    timeMax: z.string().optional().describe('End time (ISO 8601). Defaults to 7 days from now.'),
    maxResults: z.number().default(20).describe('Max events to return'),
    query: z.string().optional().describe('Free text search query'),
  },
  async ({ calendarId, timeMin, timeMax, maxResults, query }) => {
    const now = new Date();
    const params = new URLSearchParams({
      timeMin: timeMin ?? now.toISOString(),
      timeMax: timeMax ?? new Date(now.getTime() + 7 * 86400_000).toISOString(),
      maxResults: String(maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    if (query) params.set('q', query);
    const data = (await gcalFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    )) as { items: Record<string, unknown>[] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data.items ?? [], null, 2) }] };
  },
);

server.tool(
  'gcal_create_event',
  'Create a new calendar event',
  {
    calendarId: z.string().default('primary'),
    summary: z.string().describe('Event title'),
    description: z.string().optional().describe('Event description'),
    location: z.string().optional().describe('Event location'),
    startDateTime: z.string().describe('Start time (ISO 8601)'),
    endDateTime: z.string().describe('End time (ISO 8601)'),
    timeZone: z.string().default('Asia/Tokyo'),
    attendees: z
      .array(z.string())
      .optional()
      .describe('List of attendee email addresses'),
  },
  async ({ calendarId, summary, description, location, startDateTime, endDateTime, timeZone, attendees }) => {
    const body: Record<string, unknown> = {
      summary,
      description,
      location,
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: endDateTime, timeZone },
    };
    if (attendees?.length) {
      body.attendees = attendees.map((email) => ({ email }));
    }
    const event = await gcalFetch(`/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(event, null, 2) }] };
  },
);

server.tool(
  'gcal_update_event',
  'Update an existing calendar event',
  {
    calendarId: z.string().default('primary'),
    eventId: z.string().describe('Event ID to update'),
    summary: z.string().optional().describe('New event title'),
    description: z.string().optional().describe('New description'),
    location: z.string().optional().describe('New location'),
    startDateTime: z.string().optional().describe('New start time (ISO 8601)'),
    endDateTime: z.string().optional().describe('New end time (ISO 8601)'),
    timeZone: z.string().default('Asia/Tokyo'),
  },
  async ({ calendarId, eventId, summary, description, location, startDateTime, endDateTime, timeZone }) => {
    const body: Record<string, unknown> = {};
    if (summary !== undefined) body.summary = summary;
    if (description !== undefined) body.description = description;
    if (location !== undefined) body.location = location;
    if (startDateTime) body.start = { dateTime: startDateTime, timeZone };
    if (endDateTime) body.end = { dateTime: endDateTime, timeZone };
    const event = await gcalFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(event, null, 2) }] };
  },
);

server.tool(
  'gcal_delete_event',
  'Delete a calendar event',
  {
    calendarId: z.string().default('primary'),
    eventId: z.string().describe('Event ID to delete'),
  },
  async ({ calendarId, eventId }) => {
    const token = await getAccessToken();
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`Delete failed: ${res.status} ${await res.text()}`);
    return { content: [{ type: 'text' as const, text: 'Event deleted successfully.' }] };
  },
);

server.tool(
  'gcal_find_free_time',
  'Find free/busy time slots',
  {
    calendarIds: z.array(z.string()).default(['primary']),
    timeMin: z.string().describe('Start of range (ISO 8601)'),
    timeMax: z.string().describe('End of range (ISO 8601)'),
  },
  async ({ calendarIds, timeMin, timeMax }) => {
    const body = {
      timeMin,
      timeMax,
      items: calendarIds.map((id) => ({ id })),
    };
    const data = await gcalFetch('/freeBusy', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
