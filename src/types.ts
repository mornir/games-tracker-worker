export interface Env {
	TWITCH_CLIENT_ID: string;
	TWITCH_CLIENT_SECRET: string;
}

export interface Game {
	id: number;
	[key: string]: unknown;
}

export interface TimeToBeat {
	hastily: number | null;
	normally: number | null;
	completely: number | null;
	count: number | null;
}

export interface GameTimeToBeatRecord {
	game_id: number;
	hastily?: number | null;
	normally?: number | null;
	completely?: number | null;
	count?: number | null;
}
