import { createExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const testEnv = {
	TWITCH_CLIENT_ID: 'test-client',
	TWITCH_CLIENT_SECRET: 'test-secret',
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('game search endpoint', () => {
	it('runs both IGDB searches, merges by ID, and preserves relevance ordering', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}

			const query = String(init?.body);
			return Response.json(
				query.startsWith('search')
					? [
							{ id: 1, name: 'Relevant' },
							{ id: 2, name: 'Also relevant' },
						]
					: [
							{ id: 2, name: 'Duplicate' },
							{ id: 3, name: 'Prefix match' },
						],
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search', {
				method: 'POST',
				body: JSON.stringify({ query: 'zelda"\\' }),
			}),
			{ ...testEnv, TWITCH_CLIENT_ID: 'merge-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			games: [
				{ id: 1, name: 'Relevant' },
				{ id: 2, name: 'Also relevant' },
				{ id: 3, name: 'Prefix match' },
			],
		});
		const queries = fetchMock.mock.calls.map(([, init]) => String(init?.body)).filter((body) => body.includes('fields id, name'));
		expect(queries).toHaveLength(2);
		const escapedQuery = 'zelda\\"\\\\';
		expect(queries[0]).toContain(`search "${escapedQuery}";`);
		expect(queries[1]).toContain(`where name ~ "${escapedQuery}"*;`);
		expect(queries[0]).toContain('fields id, name, slug, cover.url, first_release_date, rating;');
		expect(queries[1]).toContain('fields id, name, slug, cover.url, first_release_date, rating;');
	});

	it('returns the successful result set if the other IGDB request fails', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}
			if (String(init?.body).startsWith('search')) {
				return Response.json([{ id: 9, name: 'Available result' }]);
			}
			return new Response(null, { status: 503 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search', {
				method: 'POST',
				body: JSON.stringify({ query: 'test' }),
			}),
			{ ...testEnv, TWITCH_CLIENT_ID: 'partial-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ games: [{ id: 9, name: 'Available result' }] });
	});

	it('returns an error when both IGDB requests fail', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}
			return new Response(null, { status: 503 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search', {
				method: 'POST',
				body: JSON.stringify({ query: 'test' }),
			}),
			{ ...testEnv, TWITCH_CLIENT_ID: 'failed-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'Unable to complete the IGDB game search' });
	});

	it('rejects malformed or empty search queries', async () => {
		for (const body of ['not json', JSON.stringify({ query: '   ' })]) {
			const response = await worker.fetch(
				new IncomingRequest('https://example.com/games/search', {
					method: 'POST',
					body,
				}),
				{ ...testEnv, TWITCH_CLIENT_ID: `invalid-${body.length}` },
				createExecutionContext(),
			);
			expect(response.status).toBe(400);
		}
	});

	it('keeps the existing health endpoint response', async () => {
		const response = await SELF.fetch('https://example.com/health');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'ok' });
	});
});
