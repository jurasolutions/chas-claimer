/**
 * This machine's names, as `URL.hostname` gives them: a developer's desk, never the deployed one.
 * The desk lets `DEV_USER` stand in for a person only here, and the connector sends a token over
 * plain http, or without the Access service token, only here.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);
