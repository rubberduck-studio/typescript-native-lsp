/**
 * A stdio proxy between Claude Code and a language server.
 *
 * It runs the server (see server.mts), forwards every frame in both directions,
 * and lets a list of features observe, rewrite, drop or inject messages. Each
 * feature works around one gap between Claude Code's LSP client and the servers,
 * and each can be removed on its own once that gap is closed upstream. With no
 * features left and idle shutdown off, the proxy itself can go: main.mts then
 * execs the server directly.
 */
import { ID_PREFIX, createFrameReader, writeMessage, type Message } from './protocol.mts';
import { startServer, type ServerCommand } from './server.mts';

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const EXIT_GRACE_MS = 5000;

export interface ProxyEvents {
	/** Another feature changed a document behind the client's back. */
	changed: string;
	/** Another feature closed a document behind the client's back. */
	closed: string;
	/** A new server replaced one stopped for being idle; it has the same documents open but none of their analysis yet. */
	restart: undefined;
	/** The session is ending; release timers. */
	shutdown: undefined;
}

export interface ProxyContext {
	log(message: string): void;
	trace(message: string): void;
	toServer(message: Message): void;
	toClient(message: Message): void;
	/** A request id the proxy recognises and keeps from the client. */
	requestId(name: string): string;
	/** Lets every feature bring the server up to date before a request is sent. */
	beforeRequest(): void;
	on<E extends keyof ProxyEvents>(event: E, handler: (payload: ProxyEvents[E]) => void): void;
	emit<E extends keyof ProxyEvents>(event: E, payload: ProxyEvents[E]): void;
}

export interface Feature {
	/**
	 * A client-to-server message. Return true to forward it as is, false to drop it,
	 * or a message to forward instead. Features see the message in list order, each
	 * receiving the previous feature's result.
	 */
	onClient?(message: Message): boolean | Message;
	/** A server response to a request whose id came from `ctx.requestId`. */
	onServer?(message: Message): void;
	/** Runs before any request reaches the server, the client's and the features' own. */
	beforeRequest?(): void;
}

export type FeatureFactory = (ctx: ProxyContext) => Feature;

export interface ProxyOptions {
	/** See ServerOptions.server. */
	server: ServerCommand;
	/** See ServerOptions.resolveServer. */
	resolveServer(): ServerCommand;
	log(message: string): void;
	debug?: boolean;
	/** See ServerOptions.idleMs. */
	idleMs: number;
	features: FeatureFactory[];
}

export function runProxy({ server: first, resolveServer, log, debug = false, idleMs, features }: ProxyOptions): void {
	const trace = debug ? log : () => {};
	const listeners: { [E in keyof ProxyEvents]: Array<(payload: ProxyEvents[E]) => void> } = { changed: [], closed: [], restart: [], shutdown: [] };
	let nextId = 0;
	let finished = false;

	const server = startServer({
		server: first,
		resolveServer,
		idleMs,
		output: process.stdout,
		log,
		trace,
		onOwnResponse(message) {
			for (const feature of active) {
				feature.onServer?.(message);
			}
		},
		onRestart: () => ctx.emit('restart', undefined),
		onExit: finish,
	});

	const ctx: ProxyContext = {
		log,
		trace,
		toServer: message => server.send(message),
		toClient: message => writeMessage(process.stdout, message),
		requestId: name => `${ID_PREFIX}${name}:${++nextId}`,
		beforeRequest: () => {
			for (const feature of active) {
				feature.beforeRequest?.();
			}
		},
		on(event, handler) {
			listeners[event].push(handler);
		},
		emit(event, payload) {
			for (const handler of listeners[event]) {
				handler(payload);
			}
		},
	};
	const active = features.map(create => create(ctx));

	const fromClient = createFrameReader((frame, parse) => {
		const message = parse();
		// Features bring the server up to date before a request; a shutdown needs none, and their
		// updates would start a server that idle shutdown has stopped, only for it to be stopped again.
		if (undefined !== message.id && undefined !== message.method && 'shutdown' !== message.method) {
			ctx.beforeRequest();
		}
		let current = message;
		let replaced = false;
		for (const feature of active) {
			if (undefined === feature.onClient) {
				continue;
			}
			const result = feature.onClient(current);
			if (false === result) {
				return;
			}
			if (true !== result) {
				current = result;
				replaced = true;
			}
		}
		server.send(current, replaced ? undefined : frame);
	});

	process.stdin.on('data', (chunk: Buffer) => {
		try {
			fromClient.push(chunk);
		} catch (error) {
			log(`protocol error: ${error instanceof Error ? error.message : String(error)}`);
			finish(1);
			server.kill('SIGTERM');
		}
	});
	process.stdin.on('end', () => server.end());
	for (const signal of SIGNALS) {
		process.on(signal, () => server.kill(signal));
	}

	/**
	 * Stops everything that keeps the event loop alive; Node exits once stdout
	 * has drained. Should anything still hold the process open after a grace
	 * period, it exits anyway: the proxy must never outlive its session. The
	 * first status reported wins.
	 */
	function finish(code: number): void {
		if (finished) {
			return;
		}
		finished = true;
		process.exitCode = code;
		process.stdin.destroy();
		ctx.emit('shutdown', undefined);
		setTimeout(() => {
			log('still running after the session ended; exiting');
			process.exit();
		}, EXIT_GRACE_MS).unref();
	}
}
