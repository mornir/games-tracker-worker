# Games Tracker IGDB Worker

This Worker proxies IGDB v4 requests so the Android app does not need to contain
the Twitch client secret or manage Twitch access tokens. It obtains and reuses a
Twitch app access token in the Worker, then forwards the IGDB response.

## Configure and run

The local `.dev.vars` file should contain the provided credentials:

```dotenv
TWITCH_CLIENT_ID="your-client-id"
TWITCH_CLIENT_SECRET="your-client-secret"
```

Keep `.dev.vars` private; it is ignored by Git. For a deployed Worker, set the
credentials as Cloudflare secrets:

```powershell
pnpm exec wrangler secret put TWITCH_CLIENT_ID
pnpm exec wrangler secret put TWITCH_CLIENT_SECRET
pnpm run deploy
```

Start the local Worker with `pnpm run dev`. The Android app sends an IGDB
Apicalypse query as a plain-text POST body. For example:

```http
POST /v4/games
Content-Type: text/plain

fields name, cover.url, rating; limit 10;
```

The Worker returns IGDB's response body and status. Any valid IGDB v4 endpoint
name can be used after `/v4/` (for example, `/v4/platforms`); requests must use
POST. `GET /health` is available for a basic health check.

The Android app can use `POST /games/search` with a JSON body:

```http
POST /games/search
Content-Type: application/json

{"query":"zelda"}
```

The endpoint runs an IGDB relevance search and a name-prefix search in parallel,
then returns `{ "games": [...] }`, with relevance matches first and duplicates
removed by IGDB game ID. If only one IGDB query succeeds, its results are still
returned.

## Access control

The proxy endpoint is currently public: anyone who knows its URL can send
queries using the configured Twitch app. The credentials are not sent to the
Android app, but public access can consume your IGDB/Twitch quota. Add
application-level authentication and/or rate limiting before exposing it
broadly; a static key embedded in the Android app is not a secure access
control.
