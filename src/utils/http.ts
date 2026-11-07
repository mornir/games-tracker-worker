export function jsonResponse(
	body: object,
	status: number,
	cacheControl = 'no-store',
	headers: HeadersInit = {},
): Response {
	return Response.json(body, {
		status,
		headers: { 'Cache-Control': cacheControl, ...Object.fromEntries(new Headers(headers)) },
	});
}

export async function cachedGet(
	request: Request,
	handler: () => Promise<Response>,
): Promise<Response> {
	const cacheKey = new Request(request.url, { method: 'GET' });
	const cache = caches.default;

	try {
		const cached = await cache.match(cacheKey);
		if (cached) return cached;
	} catch (error) {
		console.error('Unable to read the Worker cache', error);
	}

	const response = await handler();
	if (!response.ok) return response;

	const cacheableResponse = new Response(response.body, response);
	cacheableResponse.headers.set('Cache-Control', 'public, max-age=60, s-maxage=300');

	try {
		await cache.put(cacheKey, cacheableResponse.clone());
	} catch (error) {
		console.error('Unable to write the Worker cache', error);
	}

	return cacheableResponse;
}
