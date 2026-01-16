const CHANGELOG_URL =
	'https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md';
const KV_KEY = 'last_seen_version';

const MAX_TELEGRAM_LENGTH = 4096;
const MAX_DISCORD_LENGTH = 2000;
const MAX_SLACK_LENGTH = 40000;

interface Env {
	KV: KVNamespace;
	TELEGRAM_BOT_TOKEN?: string;
	TELEGRAM_CHAT_ID?: string;
	TELEGRAM_THREAD_ID?: string;
	DISCORD_WEBHOOK_URL?: string;
	SLACK_WEBHOOK_URL?: string;
}

interface VersionEntry {
	version: string;
	content: string;
}

interface NotificationResult {
	platform: string;
	success: boolean;
}

// Truncate message to max length with ellipsis
function truncateMessage(message: string, maxLength: number): string {
	if (message.length <= maxLength) {
		return message;
	}
	return message.slice(0, maxLength - 4) + '\n...';
}

// Parse changelog markdown into version entries
function parseChangelog(markdown: string): VersionEntry[] {
	const entries: VersionEntry[] = [];
	const lines = markdown.split('\n');

	let currentVersion: string | null = null;
	let currentContent: string[] = [];

	for (const line of lines) {
		const versionMatch = line.match(/^## (\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/);

		if (versionMatch) {
			if (currentVersion) {
				entries.push({
					version: currentVersion,
					content: currentContent.join('\n').trim(),
				});
			}
			currentVersion = versionMatch[1];
			currentContent = [];
		} else if (currentVersion) {
			currentContent.push(line);
		}
	}

	if (currentVersion) {
		entries.push({
			version: currentVersion,
			content: currentContent.join('\n').trim(),
		});
	}

	return entries;
}

// Get new versions since the last seen version
function getNewVersions(entries: VersionEntry[], lastSeenVersion: string): VersionEntry[] {
	const lastSeenIndex = entries.findIndex((e) => e.version === lastSeenVersion);

	// If last seen version not found in changelog, treat as first run to avoid spam
	if (lastSeenIndex === -1) {
		console.warn(`Last seen version ${lastSeenVersion} not found in changelog, treating as first run`);
		return [];
	}

	return entries.slice(0, lastSeenIndex);
}

// Format version entry for notification
function formatVersionMessage(entry: VersionEntry): string {
	return `📦 Claude Code v${entry.version}\n\n${entry.content}`;
}

// Send notification to Telegram
async function sendTelegram(
	message: string,
	botToken: string,
	chatId: string,
	threadId?: string
): Promise<NotificationResult> {
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	const truncatedMessage = truncateMessage(message, MAX_TELEGRAM_LENGTH);

	const body: Record<string, string | number> = {
		chat_id: chatId,
		text: truncatedMessage,
		parse_mode: 'Markdown',
	};

	if (threadId) {
		body.message_thread_id = parseInt(threadId, 10);
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		console.error(`Telegram error: ${response.status} ${await response.text()}`);
	}

	return { platform: 'Telegram', success: response.ok };
}

// Send notification to Discord
async function sendDiscord(message: string, webhookUrl: string): Promise<NotificationResult> {
	const truncatedMessage = truncateMessage(message, MAX_DISCORD_LENGTH);

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ content: truncatedMessage }),
	});

	if (!response.ok) {
		console.error(`Discord error: ${response.status} ${await response.text()}`);
	}

	return { platform: 'Discord', success: response.ok };
}

// Send notification to Slack
async function sendSlack(message: string, webhookUrl: string): Promise<NotificationResult> {
	const truncatedMessage = truncateMessage(message, MAX_SLACK_LENGTH);

	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ text: truncatedMessage }),
	});

	if (!response.ok) {
		console.error(`Slack error: ${response.status} ${await response.text()}`);
	}

	return { platform: 'Slack', success: response.ok };
}

// Send notifications to all configured platforms
async function sendNotifications(message: string, env: Env): Promise<boolean> {
	const promises: Promise<NotificationResult>[] = [];

	if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
		promises.push(
			sendTelegram(message, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, env.TELEGRAM_THREAD_ID)
		);
	}

	if (env.DISCORD_WEBHOOK_URL) {
		promises.push(sendDiscord(message, env.DISCORD_WEBHOOK_URL));
	}

	if (env.SLACK_WEBHOOK_URL) {
		promises.push(sendSlack(message, env.SLACK_WEBHOOK_URL));
	}

	if (promises.length === 0) {
		console.warn('No notification platforms configured');
		return false;
	}

	const results = await Promise.all(promises);
	const successCount = results.filter((r) => r.success).length;
	const failedPlatforms = results.filter((r) => !r.success).map((r) => r.platform);

	if (failedPlatforms.length > 0) {
		console.error(`Failed to send to: ${failedPlatforms.join(', ')}`);
	}

	// Return true if at least one platform succeeded
	return successCount > 0;
}

// Check for changelog updates and send notifications
async function checkChangelog(env: Env): Promise<void> {
	const response = await fetch(CHANGELOG_URL);
	if (!response.ok) {
		console.error(`Failed to fetch changelog: ${response.status}`);
		return;
	}

	const markdown = await response.text();
	const entries = parseChangelog(markdown);

	if (entries.length === 0) {
		console.log('No version entries found in changelog');
		return;
	}

	const latestVersion = entries[0].version;
	const lastSeenVersion = await env.KV.get(KV_KEY);

	if (!lastSeenVersion) {
		console.log(`First run - storing latest version: ${latestVersion}`);
		await env.KV.put(KV_KEY, latestVersion);
		return;
	}

	if (latestVersion === lastSeenVersion) {
		console.log(`No new updates. Current version: ${latestVersion}`);
		return;
	}

	const newVersions = getNewVersions(entries, lastSeenVersion);

	if (newVersions.length === 0) {
		console.log('No new versions to notify');
		await env.KV.put(KV_KEY, latestVersion);
		return;
	}

	console.log(`Found ${newVersions.length} new version(s)`);

	// Send notifications for each new version (oldest first)
	let allSucceeded = true;
	for (const entry of [...newVersions].reverse()) {
		const message = formatVersionMessage(entry);
		const success = await sendNotifications(message, env);
		if (!success) {
			allSucceeded = false;
		}
	}

	if (allSucceeded) {
		await env.KV.put(KV_KEY, latestVersion);
		console.log(`Updated last seen version to: ${latestVersion}`);
	} else {
		console.error('Some notifications failed, not updating last seen version');
	}
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === '/check') {
			await checkChangelog(env);
			return new Response('Changelog check completed');
		}

		url.pathname = '/__scheduled';
		url.searchParams.set('cron', '*/15 * * * *');
		return new Response(
			`Claude Code Changelog Monitor\n\nTo test the scheduled handler, run:\ncurl "${url.href}"\n\nOr trigger a manual check:\ncurl "${new URL('/check', req.url).href}"`
		);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`Scheduled trigger fired at ${event.cron}`);
		ctx.waitUntil(checkChangelog(env));
	},
} satisfies ExportedHandler<Env>;
