import { routeRequest } from './routes';

const worker: { fetch: ExportedHandlerFetchHandler<Env> } = {
	fetch: routeRequest,
};

export default worker;
