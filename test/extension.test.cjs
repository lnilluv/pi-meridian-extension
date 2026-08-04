const assert = require("node:assert/strict");
const test = require("node:test");
const { createJiti } = require("@mariozechner/jiti");
const packageJson = require("../package.json");

const jiti = createJiti(__filename);

async function loadExtension() {
	const mod = await jiti.import("../extensions/index.ts");
	return mod.default;
}

function createMockPi() {
	const pi = {
		providers: new Map(),
		commands: new Map(),
		handlers: new Map(),
		thinkingLevel: "high",
		registerProvider(name, config) {
			this.providers.set(name, config);
		},
		registerCommand(name, config) {
			this.commands.set(name, config);
		},
		on(event, handler) {
			this.handlers.set(event, handler);
		},
		getThinkingLevel() {
			return this.thinkingLevel;
		},
	};
	return pi;
}

async function registerWithEnv(env = {}) {
	const previous = {
		MERIDIAN_API_KEY: process.env.MERIDIAN_API_KEY,
		MERIDIAN_PROFILE: process.env.MERIDIAN_PROFILE,
		MERIDIAN_BASE_URL: process.env.MERIDIAN_BASE_URL,
	};
	for (const key of Object.keys(previous)) delete process.env[key];
	Object.assign(process.env, env);
	try {
		const extension = await loadExtension();
		const pi = createMockPi();
		extension(pi);
		return pi;
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("provider uses MERIDIAN_API_KEY and MERIDIAN_PROFILE when configured", async () => {
	const pi = await registerWithEnv({
		MERIDIAN_API_KEY: "secret-key",
		MERIDIAN_PROFILE: "work",
	});

	const provider = pi.providers.get("meridian");
	assert.equal(provider.apiKey, "secret-key");
	assert.equal(provider.authHeader, true);
	assert.deepEqual(provider.headers, {
		"x-meridian-agent": "pi",
		"x-meridian-profile": "work",
	});
});

test("provider defaults to placeholder api key and omits blank profile", async () => {
	const pi = await registerWithEnv({ MERIDIAN_PROFILE: "   " });

	const provider = pi.providers.get("meridian");
	assert.equal(provider.apiKey, "meridian");
	assert.deepEqual(provider.headers, { "x-meridian-agent": "pi" });
});

test("provider model catalog matches Meridian 1.60", async () => {
	const pi = await registerWithEnv();
	const provider = pi.providers.get("meridian");

	const sonnetCost = {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	};
	const opusCost = {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	};
	const fableCost = {
		input: 10,
		output: 50,
		cacheRead: 1,
		cacheWrite: 12.5,
	};
	const haikuCost = {
		input: 1,
		output: 5,
		cacheRead: 0.1,
		cacheWrite: 1.25,
	};
	assert.deepEqual(provider.models, [
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text", "image"],
			cost: sonnetCost,
			contextWindow: 200_000,
			maxTokens: 128_000,
		},
		{
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { xhigh: "max" },
			input: ["text", "image"],
			cost: sonnetCost,
			contextWindow: 200_000,
			maxTokens: 64_000,
		},
		{
			id: "claude-opus-5",
			name: "Claude Opus 5 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text", "image"],
			cost: opusCost,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		},
		...[
			["claude-opus-4-6", "Claude Opus 4.6 (Meridian)", { xhigh: "max" }],
			[
				"claude-opus-4-7",
				"Claude Opus 4.7 (Meridian)",
				{ xhigh: "xhigh" },
			],
			[
				"claude-opus-4-8",
				"Claude Opus 4.8 (Meridian)",
				{ xhigh: "xhigh" },
			],
		].map(([id, name, thinkingLevelMap]) => ({
			id,
			name,
			reasoning: true,
			thinkingLevelMap,
			input: ["text", "image"],
			cost: opusCost,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		})),
		{
			id: "claude-fable-5",
			name: "Claude Fable 5 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { off: null, xhigh: "xhigh" },
			input: ["text", "image"],
			cost: fableCost,
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		},
		{
			id: "claude-haiku-4-5",
			name: "Claude Haiku 4.5 (Meridian)",
			reasoning: true,
			input: ["text", "image"],
			cost: haikuCost,
			contextWindow: 200_000,
			maxTokens: 64_000,
		},
	]);
});

test("package uses the current Pi host package", () => {
	assert.equal(
		packageJson.peerDependencies["@earendil-works/pi-coding-agent"],
		"*",
	);
	assert.equal(
		packageJson.devDependencies["@earendil-works/pi-coding-agent"],
		"0.81.1",
	);
	assert.equal(
		packageJson.peerDependencies["@mariozechner/pi-coding-agent"],
		undefined,
	);
});

test("Claude 5 requests convert legacy budget thinking to adaptive", async () => {
	const pi = await registerWithEnv();
	pi.thinkingLevel = "xhigh";
	const beforeProviderRequest = pi.handlers.get("before_provider_request");

	const payload = await beforeProviderRequest(
		{
			payload: {
				model: "claude-opus-5",
				messages: [{ role: "user", content: "hello" }],
				thinking: {
					type: "enabled",
					budget_tokens: 16_384,
					display: "summarized",
				},
				temperature: 0.7,
			},
		},
		{
			model: { provider: "meridian", id: "claude-opus-5" },
			cwd: "/workspace",
			getSystemPrompt: () => "original system prompt",
		},
	);

	assert.deepEqual(payload.thinking, {
		type: "adaptive",
		display: "summarized",
	});
	assert.deepEqual(payload.output_config, { effort: "xhigh" });
	assert.equal("temperature" in payload, false);
	assert.equal("budget_tokens" in payload.thinking, false);
	assert.match(payload.system, /Claude Code operating through Meridian/);
});

test("adaptive requests preserve output configuration and map minimal effort", async () => {
	const pi = await registerWithEnv();
	pi.thinkingLevel = "minimal";
	const beforeProviderRequest = pi.handlers.get("before_provider_request");
	const format = {
		type: "json_schema",
		schema: { type: "object" },
	};

	const payload = await beforeProviderRequest(
		{
			payload: {
				thinking: { type: "enabled", budget_tokens: 1_024 },
				output_config: { format },
				top_p: 0.8,
				top_k: 20,
			},
		},
		{
			model: { provider: "meridian", id: "claude-sonnet-5" },
			cwd: "/workspace",
			getSystemPrompt: () => "system",
		},
	);

	assert.deepEqual(payload.output_config, { format, effort: "low" });
	assert.equal("top_p" in payload, false);
	assert.equal("top_k" in payload, false);
});

test("Claude 4.6 maps pi xhigh thinking to max effort", async () => {
	const pi = await registerWithEnv();
	pi.thinkingLevel = "xhigh";
	const beforeProviderRequest = pi.handlers.get("before_provider_request");

	const payload = await beforeProviderRequest(
		{ payload: { thinking: { type: "enabled", budget_tokens: 64_000 } } },
		{
			model: { provider: "meridian", id: "claude-opus-4-6" },
			cwd: "/workspace",
			getSystemPrompt: () => "system",
		},
	);

	assert.deepEqual(payload.thinking, { type: "adaptive" });
	assert.deepEqual(payload.output_config, { effort: "max" });
});

test("Haiku request settings are not normalized as adaptive", async () => {
	const pi = await registerWithEnv();
	const beforeProviderRequest = pi.handlers.get("before_provider_request");
	const thinking = { type: "enabled", budget_tokens: 2_048 };

	const payload = await beforeProviderRequest(
		{ payload: { thinking, temperature: 0.4 } },
		{
			model: { provider: "meridian", id: "claude-haiku-4-5" },
			cwd: "/workspace",
			getSystemPrompt: () => "system",
		},
	);

	assert.deepEqual(payload.thinking, thinking);
	assert.equal(payload.temperature, 0.4);
});

test("/meridian health sends configured auth and profile headers", async (t) => {
	const originalFetch = global.fetch;
	const requests = [];
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async (url, init) => {
		requests.push({ url, init });
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					status: "healthy",
					mode: "sdk",
					auth: { loggedIn: false },
				}),
		};
	};

	const pi = await registerWithEnv({
		MERIDIAN_API_KEY: "secret-key",
		MERIDIAN_PROFILE: "work",
	});
	const command = pi.commands.get("meridian");
	await command.handler("", {
		signal: new AbortController().signal,
		ui: { notify() {} },
	});

	assert.equal(requests.length, 1);
	assert.equal(requests[0].init.headers.Authorization, "Bearer secret-key");
	assert.equal(requests[0].init.headers["x-meridian-agent"], "pi");
	assert.equal(requests[0].init.headers["x-meridian-profile"], "work");
});

test("/meridian health displays runtime version even when not logged in", async (t) => {
	const originalFetch = global.fetch;
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async () => ({
		ok: true,
		status: 200,
		text: async () =>
			JSON.stringify({
				status: "healthy",
				version: "1.41.1",
				mode: "sdk",
				auth: { loggedIn: false },
			}),
	});

	const pi = await registerWithEnv();
	const command = pi.commands.get("meridian");
	const notifications = [];
	await command.handler("", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Version: 1\.41\.1/);
	assert.match(notifications[0].message, /Mode: sdk/);
});

test("/meridian health displays runtime version when available", async (t) => {
	const originalFetch = global.fetch;
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async () => ({
		ok: true,
		status: 200,
		text: async () =>
			JSON.stringify({
				status: "healthy",
				version: "1.60.0",
				mode: "sdk",
				auth: {
					loggedIn: true,
					email: "user@example.com",
					subscriptionType: "max",
				},
			}),
	});

	const pi = await registerWithEnv();
	const command = pi.commands.get("meridian");
	const notifications = [];
	await command.handler("", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "info");
	assert.match(notifications[0].message, /Version: 1\.60\.0/);
});

test("/meridian health warns when the runtime is too old", async (t) => {
	const originalFetch = global.fetch;
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async () => ({
		ok: true,
		status: 200,
		text: async () =>
			JSON.stringify({
				status: "healthy",
				version: "1.59.9",
				mode: "sdk",
				auth: {
					loggedIn: true,
					email: "user@example.com",
					subscriptionType: "max",
				},
			}),
	});

	const pi = await registerWithEnv();
	const command = pi.commands.get("meridian");
	const notifications = [];
	await command.handler("", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /requires Meridian >=1\.60\.0/);
});
