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

test("custom-port start passes the URL port through MERIDIAN_PORT", async (t) => {
	const childProcess = require("node:child_process");
	const originalSpawn = childProcess.spawn;
	const originalFetch = global.fetch;
	const spawned = [];
	let healthCalls = 0;

	t.after(() => {
		childProcess.spawn = originalSpawn;
		global.fetch = originalFetch;
	});

	childProcess.spawn = (command, args, options) => {
		spawned.push({ command, args, options });
		return {
			unref() {},
			on() {
				return this;
			},
		};
	};
	global.fetch = async () => {
		healthCalls += 1;
		if (healthCalls === 1) throw new Error("connection refused");
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					status: "healthy",
					mode: "passthrough",
					auth: {
						loggedIn: true,
						email: "user@example.com",
						subscriptionType: "max",
					},
				}),
		};
	};

	const pi = await registerWithEnv({
		MERIDIAN_BASE_URL: "http://127.0.0.1:3457",
	});
	const notifications = [];
	await pi.commands.get("meridian").handler("start", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].command, "meridian");
	assert.deepEqual(spawned[0].args, []);
	assert.equal(spawned[0].options.env.MERIDIAN_PORT, "3457");
	assert.equal(notifications.at(-1).level, "info");

	for (const [baseUrl, expectedPort] of [
		["http://127.0.0.1:80", "80"],
		["https://127.0.0.1:443", "443"],
	]) {
		spawned.length = 0;
		healthCalls = 0;
		const defaultSchemePi = await registerWithEnv({
			MERIDIAN_BASE_URL: baseUrl,
		});
		await defaultSchemePi.commands.get("meridian").handler("start", {
			signal: new AbortController().signal,
			ui: { notify() {} },
		});
		assert.equal(spawned.length, 1);
		assert.equal(spawned[0].options.env.MERIDIAN_PORT, expectedPort);
	}
});

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

test("provider model catalog uses safe context defaults before refresh", async () => {
	const pi = await registerWithEnv();
	const provider = pi.providers.get("meridian");

	const sonnet5Cost = {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 2.5,
	};
	const sonnet46Cost = {
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
	const fable51Cost = {
		input: 10,
		output: 50,
		cacheRead: 0.25,
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
			cost: sonnet5Cost,
			contextWindow: 200_000,
			maxTokens: 128_000,
		},
		{
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { xhigh: "max" },
			input: ["text", "image"],
			cost: sonnet46Cost,
			contextWindow: 200_000,
			maxTokens: 128_000,
		},
		{
			id: "claude-opus-5",
			name: "Claude Opus 5 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
			input: ["text", "image"],
			cost: opusCost,
			contextWindow: 200_000,
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
			contextWindow: 200_000,
			maxTokens: 128_000,
		})),
		{
			id: "claude-fable-5",
			name: "Claude Fable 5 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { off: null, xhigh: "xhigh" },
			input: ["text", "image"],
			cost: fableCost,
			contextWindow: 200_000,
			maxTokens: 128_000,
		},
		{
			id: "claude-fable-5-1",
			name: "Claude Fable 5.1 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
			input: ["text", "image"],
			cost: fable51Cost,
			contextWindow: 200_000,
			maxTokens: 128_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
		},
		{
			id: "claude-mythos-5-1",
			name: "Claude Mythos 5.1 (Meridian)",
			reasoning: true,
			thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
			input: ["text", "image"],
			cost: fable51Cost,
			contextWindow: 200_000,
			maxTokens: 128_000,
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
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

test("model refresh applies Meridian's account-aware context windows", async (t) => {
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
			json: async () => ({
				data: [
					{ id: "claude-opus-5", context_window: 1_000_000 },
					{ id: "claude-fable-5", context_window: 1_000_000 },
					{ id: "claude-sonnet-5", context_window: 200_000 },
				],
			}),
		};
	};

	const pi = await registerWithEnv();
	const provider = pi.providers.get("meridian");
	const models = await provider.refreshModels({
		allowNetwork: true,
		signal: new AbortController().signal,
		store: {},
	});

	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, "http://127.0.0.1:3456/v1/models");
	assert.equal(requests[0].init.headers.Authorization, "Bearer meridian");
	assert.equal(
		models.find(({ id }) => id === "claude-opus-5").contextWindow,
		1_000_000,
	);
	assert.equal(
		models.find(({ id }) => id === "claude-fable-5").contextWindow,
		1_000_000,
	);
	assert.equal(
		models.find(({ id }) => id === "claude-fable-5-1").contextWindow,
		1_000_000,
	);
	assert.equal(
		models.find(({ id }) => id === "claude-mythos-5-1").contextWindow,
		1_000_000,
	);
	assert.equal(
		models.find(({ id }) => id === "claude-opus-4-6").contextWindow,
		200_000,
	);

	const aborted = new AbortController();
	aborted.abort();
	const retained = await provider.refreshModels({
		allowNetwork: true,
		signal: aborted.signal,
		store: {},
	});
	assert.equal(requests.length, 1);
	assert.equal(
		retained.find(({ id }) => id === "claude-fable-5-1").contextWindow,
		1_000_000,
	);

	global.fetch = async (url, init) => {
		requests.push({ url, init });
		await new Promise((_, reject) => {
			init.signal.addEventListener(
				"abort",
				() => reject(new Error("request aborted")),
				{ once: true },
			);
		});
	};
	const inFlightAbort = new AbortController();
	const inFlightRefresh = provider.refreshModels({
		allowNetwork: true,
		signal: inFlightAbort.signal,
		store: {},
	});
	inFlightAbort.abort();
	const retainedInFlight = await inFlightRefresh;
	assert.equal(requests.length, 2);
	assert.equal(
		retainedInFlight.find(({ id }) => id === "claude-mythos-5-1").contextWindow,
		1_000_000,
	);

	const offline = await provider.refreshModels({
		allowNetwork: false,
		signal: new AbortController().signal,
		store: {},
	});
	assert.equal(
		offline.find(({ id }) => id === "claude-mythos-5-1").contextWindow,
		1_000_000,
	);
	assert.equal(requests.length, 2);
});

test("model refresh falls back to safe defaults when the catalog is unavailable", async (t) => {
	const originalFetch = global.fetch;
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async () => ({ ok: false, status: 503 });
	const pi = await registerWithEnv();
	const provider = pi.providers.get("meridian");
	const refreshContext = {
		allowNetwork: true,
		signal: new AbortController().signal,
		store: {},
	};

	await assert.rejects(
		provider.refreshModels(refreshContext),
		/Meridian model catalog request failed: HTTP 503/,
	);

	const fallback = await provider.refreshModels({
		...refreshContext,
		allowNetwork: false,
	});
	assert.equal(
		fallback.find(({ id }) => id === "claude-opus-5").contextWindow,
		200_000,
	);

	const aborted = new AbortController();
	aborted.abort();
	const abortedFallback = await provider.refreshModels({
		...refreshContext,
		signal: aborted.signal,
	});
	assert.equal(
		abortedFallback.find(({ id }) => id === "claude-fable-5").contextWindow,
		200_000,
	);
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

test("Fable-tier 5.1 models convert legacy thinking and strip unsupported sampling", async () => {
	const pi = await registerWithEnv();
	pi.thinkingLevel = "xhigh";
	const beforeProviderRequest = pi.handlers.get("before_provider_request");

	for (const modelId of ["claude-fable-5-1", "claude-mythos-5-1"]) {
		const payload = await beforeProviderRequest(
			{
				payload: {
					model: modelId,
					thinking: {
						type: "enabled",
						budget_tokens: 16_384,
						display: "summarized",
					},
					temperature: 0.7,
					top_p: 0.8,
					top_k: 20,
				},
			},
			{
				model: { provider: "meridian", id: modelId },
				cwd: "/workspace",
				getSystemPrompt: () => "system",
			},
		);

		assert.deepEqual(payload.thinking, {
			type: "adaptive",
			display: "summarized",
		});
		assert.deepEqual(payload.output_config, { effort: "xhigh" });
		assert.equal("temperature" in payload, false);
		assert.equal("top_p" in payload, false);
		assert.equal("top_k" in payload, false);
	}
});

test("always-on Fable-tier thinking ignores an explicit disabled mode", async () => {
	const pi = await registerWithEnv();
	const beforeProviderRequest = pi.handlers.get("before_provider_request");

	for (const modelId of ["claude-fable-5-1", "claude-mythos-5-1"]) {
		const payload = await beforeProviderRequest(
			{
				payload: {
					model: modelId,
					thinking: { type: "disabled" },
				},
			},
			{
				model: { provider: "meridian", id: modelId },
				cwd: "/workspace",
				getSystemPrompt: () => "system",
			},
		);

		assert.equal("thinking" in payload, false);
	}
});

test("Fable-tier 5.1 models remove forced tool choices but preserve normal choices", async () => {
	const pi = await registerWithEnv();
	const beforeProviderRequest = pi.handlers.get("before_provider_request");

	for (const modelId of ["claude-fable-5-1", "claude-mythos-5-1"]) {
		for (const toolChoice of [
			"any",
			"tool",
			{ type: "any" },
			{ type: "tool", name: "read" },
		]) {
			const payload = await beforeProviderRequest(
				{ payload: { model: modelId, tool_choice: toolChoice } },
				{
					model: { provider: "meridian", id: modelId },
					cwd: "/workspace",
					getSystemPrompt: () => "system",
				},
			);

			assert.equal("tool_choice" in payload, false);
		}

		const normalChoice = await beforeProviderRequest(
			{
				payload: { model: modelId, tool_choice: { type: "auto" } },
			},
			{
				model: { provider: "meridian", id: modelId },
				cwd: "/workspace",
				getSystemPrompt: () => "system",
			},
		);
		assert.deepEqual(normalChoice.tool_choice, { type: "auto" });
	}
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

test("non-Meridian requests bypass Meridian normalization", async () => {
	const pi = await registerWithEnv();
	const beforeProviderRequest = pi.handlers.get("before_provider_request");
	const payload = {
		model: "claude-fable-5-1",
		thinking: { type: "enabled", budget_tokens: 2_048 },
		temperature: 0.4,
		tool_choice: "any",
	};

	const result = await beforeProviderRequest(
		{ payload },
		{
			model: { provider: "anthropic", id: "claude-fable-5-1" },
			cwd: "/workspace",
			getSystemPrompt: () => "original system prompt",
		},
	);

	assert.equal(result, undefined);
	assert.deepEqual(payload, {
		model: "claude-fable-5-1",
		thinking: { type: "enabled", budget_tokens: 2_048 },
		temperature: 0.4,
		tool_choice: "any",
	});
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

test("session_start preserves passthrough and version warnings", async (t) => {
	const originalFetch = global.fetch;
	const originalPath = process.env.PATH;
	t.after(() => {
		global.fetch = originalFetch;
		process.env.PATH = originalPath;
	});

	global.fetch = async () => ({
		ok: true,
		status: 200,
		text: async () =>
			JSON.stringify({
				status: "healthy",
				version: "1.59.0",
				mode: "internal",
				auth: {
					loggedIn: true,
					email: "user@example.com",
				},
			}),
	});
	process.env.PATH = "";

	const pi = await registerWithEnv();
	const notifications = [];
	await pi.handlers.get("session_start")(
		{},
		{
			model: { provider: "meridian" },
			ui: {
				notify(message, level) {
					notifications.push({ message, level });
				},
			},
		},
	);

	assert.deepEqual(notifications, [
		{
			message:
				"Meridian is running in internal mode; Pi-owned tools are not forwarded. Restart Meridian with passthrough enabled for Pi's normal tool loop.",
			level: "warning",
		},
		{
			message:
				"This extension requires Meridian >=1.60.0; runtime v1.59.0 may not support the registered models.",
			level: "warning",
		},
	]);
});

test("/meridian health warns when Pi passthrough is disabled", async (t) => {
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
				version: "1.62.7",
				mode: "internal",
				auth: {
					loggedIn: true,
					email: "user@example.com",
					subscriptionType: "max",
				},
			}),
	});

	const pi = await registerWithEnv();
	const notifications = [];
	await pi.commands.get("meridian").handler("", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Mode: internal/);
	assert.match(notifications[0].message, /Pi-owned tools are not forwarded/);
});

test("/meridian start preserves passthrough and version warnings", async (t) => {
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
				version: "1.59.0",
				mode: "internal",
				auth: { loggedIn: true, email: "user@example.com" },
			}),
	});

	const pi = await registerWithEnv();
	const notifications = [];
	await pi.commands.get("meridian").handler("start", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 2);
	assert.match(notifications[0].message, /Pi-owned tools are not forwarded/);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[1].message, /requires Meridian >=1.60.0/);
	assert.equal(notifications[1].level, "warning");
});

test("/meridian start preserves primary diagnostics", async (t) => {
	const childProcess = require("node:child_process");
	const originalSpawn = childProcess.spawn;
	const originalFetch = global.fetch;
	t.after(() => {
		childProcess.spawn = originalSpawn;
		global.fetch = originalFetch;
	});
	childProcess.spawn = () => ({
		unref() {},
		on() {
			return this;
		},
	});

	global.fetch = async () => ({
		ok: true,
		status: 200,
		text: async () =>
			JSON.stringify({
				status: "degraded",
				message: "Meridian is serving a reduced-capacity pool.",
			}),
	});

	let pi = await registerWithEnv();
	let notifications = [];
	await pi.commands.get("meridian").handler("start", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Meridian degraded/);
	assert.match(notifications[0].message, /reduced-capacity pool/);

	let healthCalls = 0;
	global.fetch = async () => {
		healthCalls += 1;
		if (healthCalls === 1) throw new Error("connection refused");
		return {
			ok: true,
			status: 200,
			text: async () =>
				JSON.stringify({
					status: "degraded",
					message: "Meridian is serving a reduced-capacity pool.",
					auth: { loggedIn: true, email: "user@example.com" },
				}),
		};
	};

	pi = await registerWithEnv();
	notifications = [];
	await pi.commands.get("meridian").handler("start", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.match(notifications[0].message, /Starting Meridian/);
	assert.equal(notifications[1].level, "warning");
	assert.match(notifications[1].message, /Meridian degraded/);
	assert.match(notifications[1].message, /reduced-capacity pool/);
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

test("/meridian health explains when Meridian is draining", async (t) => {
	const originalFetch = global.fetch;
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async () => ({
		ok: false,
		status: 503,
		text: async () =>
			JSON.stringify({
				status: "draining",
				version: "1.62.7",
				message:
					"Meridian is shutting down; route new requests to another instance.",
			}),
	});

	const pi = await registerWithEnv();
	const notifications = [];
	await pi.commands.get("meridian").handler("", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Meridian is draining/);
	assert.match(notifications[0].message, /route new requests to another instance/);
});

test("/meridian start reports a draining daemon", async (t) => {
	const originalFetch = global.fetch;
	t.after(() => {
		global.fetch = originalFetch;
	});

	global.fetch = async () => ({
		ok: false,
		status: 503,
		text: async () =>
			JSON.stringify({
				status: "draining",
				message: "Meridian is shutting down",
			}),
	});

	const pi = await registerWithEnv();
	const notifications = [];
	await pi.commands.get("meridian").handler("start", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Meridian is draining/);
});

test("/meridian version preserves the draining message", async (t) => {
	const originalFetch = global.fetch;
	const originalPath = process.env.PATH;
	t.after(() => {
		global.fetch = originalFetch;
		process.env.PATH = originalPath;
	});

	global.fetch = async () => ({
		ok: false,
		status: 503,
		text: async () =>
			JSON.stringify({
				status: "draining",
				message: "Meridian is shutting down; route new requests elsewhere.",
			}),
	});

	const pi = await registerWithEnv();
	process.env.PATH = "";
	const notifications = [];
	await pi.commands.get("meridian").handler("version", {
		signal: new AbortController().signal,
		ui: {
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	});

	assert.equal(notifications.length, 2);
	assert.equal(notifications[1].level, "warning");
	assert.match(notifications[1].message, /Draining at/);
	assert.match(
		notifications[1].message,
		/Meridian is shutting down; route new requests elsewhere\./,
	);
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
