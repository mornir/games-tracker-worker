import type { Env, Game, TimeToBeat } from '../types';
import { queryGameTimeToBeats, queryGames } from './igdb';

const SEARCH_FIELDS = 'id, name, slug, cover.url, first_release_date, rating';
const DETAIL_FIELDS =
	'id, name, slug, summary, storyline, cover.url, artworks.url, screenshots.url, first_release_date, rating, rating_count, genres.name, platforms.name, game_modes.name, themes.name, involved_companies.company.name, involved_companies.developer, involved_companies.publisher';
const TIME_TO_BEAT_FIELDS = 'game_id, hastily, normally, completely, count';

function escapeApicalypseString(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export async function searchGames(query: string, env: Env): Promise<Game[]> {
	const escapedQuery = escapeApicalypseString(query);
	const [exact, relevance, prefix] = await Promise.allSettled([
		queryGames('games', `where name = "${escapedQuery}"; fields ${SEARCH_FIELDS};`, env),
		queryGames('games', `search "${escapedQuery}"; fields ${SEARCH_FIELDS};`, env),
		queryGames('games', `where name ~ "${escapedQuery}"*; fields ${SEARCH_FIELDS};`, env),
	]);

	if (exact.status === 'rejected') {
		console.error('IGDB exact-title game search failed', exact.reason);
	}
	if (relevance.status === 'rejected') {
		console.error('IGDB relevance game search failed', relevance.reason);
	}
	if (prefix.status === 'rejected') {
		console.error('IGDB prefix game search failed', prefix.reason);
	}
	if (exact.status === 'rejected' && relevance.status === 'rejected' && prefix.status === 'rejected') {
		throw new Error('Unable to complete the IGDB game search');
	}

	const games = new Map<number, Game>();
	if (exact.status === 'fulfilled') {
		for (const game of exact.value) games.set(game.id, game);
	}
	if (relevance.status === 'fulfilled') {
		for (const game of relevance.value) {
			if (!games.has(game.id)) games.set(game.id, game);
		}
	}
	if (prefix.status === 'fulfilled') {
		for (const game of prefix.value) {
			if (!games.has(game.id)) games.set(game.id, game);
		}
	}

	return [...games.values()].sort((a, b) => Number(a.rating == null) - Number(b.rating == null));
}

export async function getGame(id: number, env: Env): Promise<Game | undefined> {
	const [game] = await queryGames('games', `where id = ${id}; fields ${DETAIL_FIELDS}; limit 1;`, env);
	if (!game) return undefined;

	let timeToBeat: TimeToBeat | null = null;
	try {
		const [record] = await queryGameTimeToBeats(
			'game_time_to_beats',
			`where game_id = ${id}; fields ${TIME_TO_BEAT_FIELDS}; limit 1;`,
			env,
		);
		if (record) {
			timeToBeat = {
				hastily: record.hastily ?? null,
				normally: record.normally ?? null,
				completely: record.completely ?? null,
				count: record.count ?? null,
			};
		}
	} catch (error) {
		console.error(`IGDB game time to beat request failed for game ${id}`, error);
	}

	return { ...game, time_to_beat: timeToBeat };
}
