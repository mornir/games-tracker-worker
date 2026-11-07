import type { Env, Game } from '../types';

let cachedToken: { clientId: string; value: string; expiresAt: number } | undefined;
let tokenRequest: { clientId: string; promise: Promise<string> } | undefined;

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
		if (tokenRequest?.promise === pending) tokenRequest = undefined;
	}
}

export async function queryGames(path: 'games', query: string, env: Env): Promise<Game[]> {
	const accessToken = await getAccessToken(env);
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
			(game): game is Game =>
				typeof game === 'object' &&
				game !== null &&
				'id' in game &&
				typeof game.id === 'number' &&
				Number.isSafeInteger(game.id),
		)
	) {
		throw new Error(`IGDB ${path} response did not contain valid game results`);
	}

	return results;
}
