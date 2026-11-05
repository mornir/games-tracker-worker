interface Env {
	TWITCH_CLIENT_ID: string;
	TWITCH_CLIENT_SECRET: string;
}

const IGDB_PATH = /^\/v4\/[a-z][a-z0-9_]*(?:\/[a-z][a-z0-9_]*)?$/;
const MAX_QUERY_BYTES = 32 * 1024;

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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/health' && request.method === 'GET') {
			return jsonResponse({ status: 'ok' }, 200);
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
