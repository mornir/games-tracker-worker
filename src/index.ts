import { routeRequest } from './routes';

export default {
	fetch: routeRequest,
} satisfies ExportedHandler<Env>;
