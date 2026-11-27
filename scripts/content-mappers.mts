/**
 * Lets TypeScript's native language server run the content mappers a project's
 * tsconfig.json declares (`contentMappers`, TypeScript 7.1 and newer), such as a
 * mapper that types `*.module.css` files.
 *
 * A mapper runs any command its package.json names, and the package can be a
 * dependency or a directory in the project, so the server starts mappers only
 * when the client sets `runExternalCode` in `initialize`. TypeScript's own VS
 * Code extension, which does not run in untrusted workspaces, sets it unless its
 * setting `js/ts.contentMappers.enabled` is off; this feature does the same in
 * every session, which runs the project's hooks and settings too. `tsc --lsp`
 * has no command-line flag for it, and the server reads a boolean, which a
 * plugin option substituted into initializationOptions is not, so the feature
 * sets it on the client's `initialize`. The server keeps the message it was
 * sent, so a server started again after idle shutdown gets the option too.
 */
import { isMethod, type Message } from './protocol.mts';
import type { Feature, ProxyContext } from './proxy.mts';

export function contentMappers(ctx: ProxyContext): Feature {
	ctx.log('content mappers on; set the plugin option content_mappers to false in /config to keep the server from running the ones a tsconfig.json declares');
	return {
		onClient(message: Message): boolean | Message {
			if (false === isMethod(message, 'initialize')) {
				return true;
			}
			const options: unknown = message.params.initializationOptions;
			const initializationOptions = 'object' === typeof options && null !== options && false === Array.isArray(options) ? { ...options, runExternalCode: true } : { runExternalCode: true };
			return { ...message, params: { ...message.params, initializationOptions } };
		},
	};
}
