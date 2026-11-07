export interface Env {
	TWITCH_CLIENT_ID: string;
	TWITCH_CLIENT_SECRET: string;
}

export interface Game {
	id: number;
	[key: string]: unknown;
}
