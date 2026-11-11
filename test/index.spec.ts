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
	vi.restoreAllMocks();
});

describe('game search endpoint', () => {
	it('puts exact title matches first, then merges relevance and prefix results by ID', async () => {
		const cache = stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}

			const query = String(init?.body);
			return Response.json(
				query.startsWith('where name =')
					? [
							{ id: 2, name: 'Exact title match' },
							{ id: 4, name: 'Another exact title match' },
						]
					: query.startsWith('search')
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
				{ id: 2, name: 'Exact title match' },
				{ id: 4, name: 'Another exact title match' },
				{ id: 1, name: 'Relevant' },
				{ id: 3, name: 'Prefix match' },
			],
		});
		const queries = fetchMock.mock.calls
			.map(([, init]) => String(init?.body))
			.filter((body) => body.includes('fields id, name'));
		expect(queries).toHaveLength(3);
		const escapedQuery = 'zelda\\"\\\\';
		expect(queries[0]).toContain(`where name = "${escapedQuery}";`);
		expect(queries[1]).toContain(`search "${escapedQuery}";`);
		expect(queries[1]).toContain('fields id, name, slug, cover.url, first_release_date, rating;');
		expect(queries[2]).toContain(`where name ~ "${escapedQuery}"*;`);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60, s-maxage=300');
		expect(cache.put).toHaveBeenCalledOnce();
	});

	it('returns Dispatch as the first result for an exact title search', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'dispatch-token', expires_in: 3600 });
			}

			const query = String(init?.body);
			return Response.json(
				query.startsWith('where name =')
					? [{ id: 325609, name: 'Dispatch' }]
					: [{ id: 1, name: 'Other result' }],
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search?q=dispatch'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'dispatch-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).games[0]).toEqual({ id: 325609, name: 'Dispatch' });
	});

	it('puts games without a rating after rated games while preserving result order', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'rating-token', expires_in: 3600 });
			}

			const query = String(init?.body);
			return Response.json(
				query.startsWith('where name =')
					? [
							{ id: 1, name: 'Unrated exact match' },
							{ id: 2, name: 'Rated exact match', rating: 80 },
						]
					: query.startsWith('search')
					? [
							{ id: 3, name: 'Rated relevant match', rating: 75 },
							{ id: 4, name: 'Null-rated relevant match', rating: null },
						]
					: [{ id: 5, name: 'Unrated prefix match' }],
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search?q=test'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'rating-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).games.map((game: { id: number }) => game.id)).toEqual([
			2, 3, 1, 4, 5,
		]);
	});

	it('returns the successful result sets if one IGDB request fails', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes('oauth2/token')) {
				return Response.json({ access_token: 'test-token', expires_in: 3600 });
			}
			if (String(init?.body).startsWith('where name =')) {
				return new Response(null, { status: 503 });
			}
			if (String(init?.body).startsWith('search')) {
				return Response.json([{ id: 9, name: 'Available result' }]);
			}
			return Response.json([{ id: 10, name: 'Prefix result' }]);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/search?q=test'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'partial-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			games: [
				{ id: 9, name: 'Available result' },
				{ id: 10, name: 'Prefix result' },
			],
		});
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
			const url = String(input);
			if (url.includes('oauth2/token')) {
				return Response.json({ access_token: 'detail-token', expires_in: 3600 });
			}
			const query = String(init?.body);
			if (url.endsWith('/games')) {
				expect(query).toContain('where id = 42;');
				expect(query).toContain('fields id, name, slug, summary');
				expect(query).toContain('involved_companies.company.name');
				return Response.json([{ id: 42, name: 'Test game', summary: 'Details' }]);
			}
			expect(url.endsWith('/game_time_to_beats')).toBe(true);
			expect(query).toContain('where game_id = 42;');
			expect(query).toContain('fields game_id, hastily, normally, completely, count;');
			return Response.json([
				{ game_id: 42, hastily: 3600, normally: 7200, completely: 14400, count: 25 },
			]);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/42'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'detail-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			game: {
				id: 42,
				name: 'Test game',
				summary: 'Details',
				time_to_beat: { hastily: 3600, normally: 7200, completely: 14400, count: 25 },
			},
		});
	});

	it('returns null Time to Beat data when IGDB has no record', async () => {
		stubCache();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('oauth2/token')) {
				return Response.json({ access_token: 'empty-time-token', expires_in: 3600 });
			}
			return url.endsWith('/games')
				? Response.json([{ id: 43, name: 'No estimate' }])
				: Response.json([]);
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/43'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'empty-time-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			game: { id: 43, name: 'No estimate', time_to_beat: null },
		});
	});

	it('returns game details with null Time to Beat data when its IGDB request fails', async () => {
		stubCache();
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('oauth2/token')) {
				return Response.json({ access_token: 'failed-time-token', expires_in: 3600 });
			}
			return url.endsWith('/games')
				? Response.json([{ id: 46, name: 'Available details' }])
				: new Response(null, { status: 503 });
		});
		vi.stubGlobal('fetch', fetchMock);

		const response = await worker.fetch(
			new IncomingRequest('https://example.com/games/46'),
			{ ...testEnv, TWITCH_CLIENT_ID: 'failed-time-test' },
			createExecutionContext(),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			game: { id: 46, name: 'Available details', time_to_beat: null },
		});
		expect(errorSpy).toHaveBeenCalledWith(
			'IGDB game time to beat request failed for game 46',
			expect.any(Error),
		);
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
