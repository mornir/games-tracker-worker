import type { Env, Game, GameTimeToBeatRecord } from '../types';

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

function isGame(value: unknown): value is Game {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		typeof value.id === 'number' &&
		Number.isSafeInteger(value.id)
	);
}

function isOptionalIntegerField(
	value: object,
	field: 'hastily' | 'normally' | 'completely' | 'count',
): boolean {
	if (!(field in value)) return true;
	const fieldValue: unknown = Reflect.get(value, field);
	return (
		fieldValue === null ||
		(typeof fieldValue === 'number' && Number.isSafeInteger(fieldValue))
	);
}

function isGameTimeToBeat(value: unknown): value is GameTimeToBeatRecord {
	return (
		typeof value === 'object' &&
		value !== null &&
		'game_id' in value &&
		typeof value.game_id === 'number' &&
		Number.isSafeInteger(value.game_id) &&
		isOptionalIntegerField(value, 'hastily') &&
		isOptionalIntegerField(value, 'normally') &&
		isOptionalIntegerField(value, 'completely') &&
		isOptionalIntegerField(value, 'count')
	);
}

async function queryIGDB<T>(
	path: 'games' | 'game_time_to_beats',
	query: string,
	env: Env,
	isValidResult: (value: unknown) => value is T,
): Promise<T[]> {
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
	if (!Array.isArray(results)) {
		throw new Error(`IGDB ${path} response did not contain valid results`);
	}

	const validatedResults: T[] = [];
	for (const result of results) {
		if (!isValidResult(result)) {
			throw new Error(`IGDB ${path} response did not contain valid results`);
		}
		validatedResults.push(result);
	}
	return validatedResults;
}

export function queryGames(path: 'games', query: string, env: Env): Promise<Game[]> {
	return queryIGDB(path, query, env, isGame);
}

export function queryGameTimeToBeats(
	path: 'game_time_to_beats',
	query: string,
	env: Env,
): Promise<GameTimeToBeatRecord[]> {
	return queryIGDB(path, query, env, isGameTimeToBeat);
}
