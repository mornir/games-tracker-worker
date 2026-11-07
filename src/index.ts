interface Env {
	TWITCH_CLIENT_ID: string;
	TWITCH_CLIENT_SECRET: string;
}

const IGDB_PATH = /^\/v4\/[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)?$/;
const MAX_QUERY_BYTES = 32 * 1024;
const GAME_FIELDS = 'id, name, slug, cover.url, first_release_date, rating';

let cachedToken: { clientId: string; value: string; expiresAt: number } | undefined;
let tokenRequest: { clientId: string; promise: Promise<string> } | undefined;

function jsonResponse(body: object, status: number): Response {
	return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function getAccessToken(env: Env): Promise<string> {
	if (cachedToken?.clientId === env.TWITCH_CLIENT_ID && Date.now() < cachedToken.expiresAt) {
		return cachedToken.value;
	}

	if (tokenRequest?.clientId === env.TWITCH_CLIENT_ID) {
		return tokenRequest.promise;
	}

	const pending = (async () => {
		const response = await fetch('https://id.twitch.tv/oauth2/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: env.TWITCH_CLIENT_ID,
				client_secret: env.TWITCH_CLIENT_SECRET,
				grant_type: 'client_credentials',
			}),
		});

		if (!response.ok) {
			throw new Error(`Twitch OAuth request failed with status ${response.status}`);
		}

		const data: unknown = await response.json();
		if (
			typeof data !== 'object' ||
			data === null ||
			!('access_token' in data) ||
			typeof data.access_token !== 'string' ||
			!('expires_in' in data) ||
			typeof data.expires_in !== 'number' ||
			!Number.isFinite(data.expires_in)
		) {
			throw new Error('Twitch OAuth response did not contain a valid access token');
		}

		cachedToken = {
			clientId: env.TWITCH_CLIENT_ID,
			value: data.access_token,
			expiresAt: Date.now() + Math.max(1, data.expires_in - 60) * 1000,
		};
		return data.access_token;
	})();

	tokenRequest = { clientId: env.TWITCH_CLIENT_ID, promise: pending };
	try {
		return await pending;
	} finally {
		if (tokenRequest?.promise === pending) {
			tokenRequest = undefined;
		}
	}
}

function escapeApicalypseString(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

async function fetchGameResults(
	path: string,
	query: string,
	env: Env,
	accessToken: string,
): Promise<Array<{ id: number; [key: string]: unknown }>> {
	const response = await fetch(`https://api.igdb.com/v4/${path}`, {
		method: 'POST',
		headers: {
			'Client-ID': env.TWITCH_CLIENT_ID,
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'text/plain',
			Accept: 'application/json',
		},
		body: query,
	});

	if (!response.ok) {
		throw new Error(`IGDB ${path} request failed with status ${response.status}`);
	}

	const results: unknown = await response.json();
	if (
		!Array.isArray(results) ||
		!results.every(
			(game): game is { id: number; [key: string]: unknown } =>
				typeof game === 'object' &&
				game !== null &&
				'id' in game &&
				typeof game.id === 'number',
		)
	) {
		throw new Error(`IGDB ${path} response did not contain valid game results`);
	}

	return results;
}

async function searchGames(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return jsonResponse({ error: 'Only POST is supported for game search' }, 405);
	}

	if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
		console.error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured');
		return jsonResponse({ error: 'IGDB proxy is not configured' }, 500);
	}

	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > MAX_QUERY_BYTES) {
		return jsonResponse({ error: 'Search request body exceeds the 32 KB limit' }, 413);
	}

	let searchQuery: unknown;
	try {
		searchQuery = (JSON.parse(body) as { query?: unknown }).query;
	} catch {
		return jsonResponse({ error: 'A JSON search request body is required' }, 400);
	}
	if (typeof searchQuery !== 'string' || !searchQuery.trim()) {
		return jsonResponse({ error: 'A non-empty search query is required' }, 400);
	}

	const escapedQuery = escapeApicalypseString(searchQuery.trim());

	try {
		const accessToken = await getAccessToken(env);
		const [relevance, prefix] = await Promise.allSettled([
			fetchGameResults(
				'games',
				`search "${escapedQuery}"; fields ${GAME_FIELDS};`,
				env,
				accessToken,
			),
			fetchGameResults(
				'games',
				`where name ~ "${escapedQuery}"*; fields ${GAME_FIELDS};`,
				env,
				accessToken,
			),
		]);

		if (relevance.status === 'rejected') {
			console.error('IGDB relevance game search failed', relevance.reason);
		}
		if (prefix.status === 'rejected') {
			console.error('IGDB prefix game search failed', prefix.reason);
		}
		if (relevance.status === 'rejected' && prefix.status === 'rejected') {
			return jsonResponse({ error: 'Unable to complete the IGDB game search' }, 502);
		}

		const games = new Map<number, { id: number; [key: string]: unknown }>();
		if (relevance.status === 'fulfilled') {
			for (const game of relevance.value) games.set(game.id, game);
		}
		if (prefix.status === 'fulfilled') {
			for (const game of prefix.value) {
				if (!games.has(game.id)) games.set(game.id, game);
			}
		}

		return jsonResponse({ games: [...games.values()] }, 200);
	} catch (error) {
		console.error('IGDB game search failed', error);
		return jsonResponse({ error: 'Unable to complete the IGDB game search' }, 502);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health' && request.method === 'GET') {
			return jsonResponse({ status: 'ok' }, 200);
		}

		if (url.pathname === '/games/search') {
			return searchGames(request, env);
		}

		if (!IGDB_PATH.test(url.pathname)) {
			return jsonResponse({ error: 'Not found' }, 404);
		}

		if (request.method !== 'POST') {
			return jsonResponse({ error: 'Only POST is supported for IGDB queries' }, 405);
		}

		if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
			console.error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured');
			return jsonResponse({ error: 'IGDB proxy is not configured' }, 500);
		}

		const query = await request.text();
		if (!query.trim()) {
			return jsonResponse({ error: 'A non-empty IGDB query body is required' }, 400);
		}
		if (new TextEncoder().encode(query).byteLength > MAX_QUERY_BYTES) {
			return jsonResponse({ error: 'IGDB query body exceeds the 32 KB limit' }, 413);
		}

		try {
			const accessToken = await getAccessToken(env);
			const upstream = await fetch(`https://api.igdb.com${url.pathname}`, {
				method: 'POST',
				headers: {
					'Client-ID': env.TWITCH_CLIENT_ID,
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'text/plain',
					Accept: 'application/json',
				},
				body: query,
			});

			return new Response(upstream.body, {
				status: upstream.status,
				headers: {
					'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json',
					'Cache-Control': 'no-store',
				},
			});
		} catch (error) {
			console.error('IGDB proxy request failed', error);
			return jsonResponse({ error: 'Unable to complete the IGDB request' }, 502);
		}
	},
} satisfies ExportedHandler<Env>;
