import type { Env } from './types';
import { getGame, searchGames } from './services/games';
import { cachedGet, jsonResponse } from './utils/http';

const MAX_SEARCH_LENGTH = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isConfigured(env: Env): boolean {
	if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) return true;
	console.error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured');
	return false;
}

function getSearchQuery(url: URL): string | Response {
	if (
		url.searchParams.getAll('q').length !== 1 ||
		[...url.searchParams.keys()].some((key) => key !== 'q')
	) {
		return jsonResponse({ error: 'Only one q parameter is supported' }, 400);
	}

	const rawQuery = url.searchParams.get('q');
	if (rawQuery === null || !rawQuery.trim()) {
		return jsonResponse({ error: 'A non-empty search query is required' }, 400);
	}
	if (CONTROL_CHARACTERS.test(rawQuery)) {
		return jsonResponse({ error: 'Search query contains invalid characters' }, 400);
	}
	const query = rawQuery.trim().replace(/\s+/g, ' ');
	if (query.length > MAX_SEARCH_LENGTH) {
		return jsonResponse(
			{ error: `Search query must be ${MAX_SEARCH_LENGTH} characters or fewer` },
			400,
		);
	}

	return query;
}

function methodNotAllowed(allow: string): Response {
	return jsonResponse({ error: 'Method not allowed' }, 405, 'no-store', { Allow: allow });
}

export async function routeRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);

	if (url.pathname === '/health' && request.method === 'GET') {
		return jsonResponse({ status: 'ok' }, 200);
	}

	if (url.pathname === '/games/search') {
		if (request.method !== 'GET') return methodNotAllowed('GET');
		const query = getSearchQuery(url);
		if (query instanceof Response) return query;
		if (!isConfigured(env)) return jsonResponse({ error: 'Game service is not configured' }, 500);

		return cachedGet(request, async () => {
			try {
				const games = await searchGames(query, env);
				return jsonResponse({ games }, 200, 'public, max-age=60, s-maxage=300');
			} catch (error) {
				console.error('IGDB game search failed', error);
				return jsonResponse({ error: 'Unable to complete the IGDB game search' }, 502);
			}
		});
	}

	const gameMatch = /^\/games\/([^/]+)$/.exec(url.pathname);
	if (gameMatch) {
		if (request.method !== 'GET') return methodNotAllowed('GET');
		if (url.search) return jsonResponse({ error: 'Game details do not accept query parameters' }, 400);
		if (!/^[1-9]\d*$/.test(gameMatch[1])) {
			return jsonResponse({ error: 'Invalid game ID' }, 400);
		}
		const id = Number(gameMatch[1]);
		if (!Number.isSafeInteger(id)) return jsonResponse({ error: 'Invalid game ID' }, 400);
		if (!isConfigured(env)) return jsonResponse({ error: 'Game service is not configured' }, 500);

		return cachedGet(request, async () => {
			try {
				const game = await getGame(id, env);
				if (!game) return jsonResponse({ error: 'Game not found' }, 404);
				return jsonResponse({ game }, 200, 'public, max-age=60, s-maxage=300');
			} catch (error) {
				console.error('IGDB game detail request failed', error);
				return jsonResponse({ error: 'Unable to retrieve game details' }, 502);
			}
		});
	}

	return jsonResponse({ error: 'Not found' }, 404);
}
