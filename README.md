# Games Tracker API

This Cloudflare Worker provides a small REST API for the Android game-tracking
app. It keeps Twitch credentials and IGDB communication on the server; clients
cannot send arbitrary IGDB queries.

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

Start the local Worker with `pnpm run dev`.

## Endpoints

- `GET /health` returns `{ "status": "ok" }`.
- `GET /games/search?q=zelda` searches by IGDB relevance and game-name prefix,
  returning `{ "games": [...] }`. Relevance matches appear first, duplicate
  games are removed by ID, and results from one successful search are returned
  if the other search fails.
- `GET /games/123` returns `{ "game": {...} }` with detailed game information,
  including a `time_to_beat` object with `hastily`, `normally`, and
  `completely` estimates in seconds and a submission `count`. The property is
  `null` when IGDB has no estimate or its Time to Beat request fails. The
  endpoint returns a JSON `404` error if the game does not exist.

Successful game responses are cached for up to five minutes at the edge and one
minute in clients. Errors are returned as JSON and are not cached. Other paths,
including the former generic `/v4/...` proxy, return `404`.
