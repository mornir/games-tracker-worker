import { createExecutionContext, SELF } from 'cloudflare:test';
import { afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const testEnv = {
	TWITCH_CLIENT_ID: 'test-client',
	TWITCH_CLIENT_SECRET: 'test-secret',
};

function stubCache(cachedResponse?: Response) {
	const cache = {
		match: vi.fn(async () => cachedResponse?.clone()),
		put: vi.fn(async () => undefined),
	};
	vi.stubGlobal('caches', { default: cache });
	return cache;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('game search endpoint', () => {
	it('runs both IGDB searches, merges by ID, and preserves relevance ordering', async () => {
		const cache = stubCache();
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
			new IncomingRequest('https://example.com/games/search?q=zelda%22%5C'),
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
		const queries = fetchMock.mock.calls
			.map(([, init]) => String(init?.body))
			.filter((body) => body.includes('fields id, name'));
		expect(queries).toHaveLength(2);
		const escapedQuery = 'zelda\\"\\\\';
		expect(queries[0]).toContain(`search "${escapedQuery}";`);
		expect(queries[1]).toContain(`where name ~ "${escapedQuery}"*;`);
		expect(queries[0]).toContain('fields id, name, slug, cover.url, first_release_date, rating;');
		expect(queries[1]).toContain('fields id, name, slug, cover.url, first_release_date, rating;');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
		expect(cache.put).toHaveBeenCalledOnce();
	});

	it('returns the successful result set if the other IGDB request fails', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}
			if (String(init?.body).startsWith('search')) {
				return Response.json([{ id: 9, name: 'Available result' }]);
			}
			return new Response(null, { status: 503 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search?q=test'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'partial-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ games: [{ id: 9, name: 'Available result' }] });
	});

	it('returns an error when both IGDB requests fail', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}
			return new Response(null, { status: 503 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search?q=test'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'failed-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'Unable to complete the IGDB game search' });
	});

	it('rejects invalid search parameters without calling IGDB', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		for (const url of [
			'https://example.com/games/search',
			'https://example.com/games/search?q=',
			'https://example.com/games/search?q=one&q=two',
			'https://example.com/games/search?q=test&query=fields',
			`https://example.com/games/search?q=${'a'.repeat(101)}`,
			'https://example.com/games/search?q=bad%0Aquery',
		]) {
			const response = await worker.fetch(
				new IncomingRequest(url),
				{ ...testEnv, TWITCH_CLIENT_ID: `invalid-${url.length}` },
				createExecutionContext(),
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toHaveProperty('error');
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects non-GET search requests', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search?q=test', { method: 'POST' }),
			testEnv,
			createExecutionContext(),
		);
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET');
	});
});

describe('game detail endpoint', () => {
	it('fetches a game by ID using a fixed field selection', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'detail-token', expires_in: 3600 });
			}
			expect(String(init?.body)).toContain('where id = 42;');
			expect(String(init?.body)).toContain('fields id, name, slug, summary');
			expect(String(init?.body)).toContain('involved_companies.company.name');
			return Response.json([{ id: 42, name: 'Test game', summary: 'Details' }]);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/42'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'detail-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			game: { id: 42, name: 'Test game', summary: 'Details' },
		});
	});

	it('returns 404 when IGDB has no matching game', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
			String(input).includes('oauth2/token')
				? Response.json({ access_token: 'missing-token', expires_in: 3600 })
				: Response.json([]),
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/44'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'missing-test' },
			createExecutionContext(),
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Game not found' });
	});

	it('serves cached successful game responses without calling IGDB', async () => {
		const cache = stubCache(Response.json({ game: { id: 45, name: 'Cached game' } }));
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/45'),
			testEnv,
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ game: { id: 45, name: 'Cached game' } });
		expect(cache.match).toHaveBeenCalledOnce();
		expect(cache.put).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('rejects invalid IDs and removes the generic IGDB proxy', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/0'),
			testEnv,
			createExecutionContext(),
		);
		expect(response.status).toBe(400);

		const queryResponse = await worker.fetch(
			new IncomingRequest('https://example.com/games/42?fields=name'),
			testEnv,
			createExecutionContext(),
		);
		expect(queryResponse.status).toBe(400);

		const proxyResponse = await worker.fetch(
			new IncomingRequest('https://example.com/v4/games', { method: 'POST', body: 'fields id;' }),
			testEnv,
			createExecutionContext(),
		);
		expect(proxyResponse.status).toBe(404);
	});

	it('returns a consistent JSON error for unsupported methods', async () => {
		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/42', { method: 'POST' }),
			testEnv,
			createExecutionContext(),
		);
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET');
		expect(await response.json()).toEqual({ error: 'Method not allowed' });
	});
});

it('keeps the existing health endpoint response', async () => {
	const response = await SELF.fetch('https://example.com/health');
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: 'ok' });
});
