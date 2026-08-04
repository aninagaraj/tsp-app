const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, 'api_cache.json');
const TTL_MS = 180 * 24 * 60 * 60 * 1000; // 6 months
const MAX = { geocode: 800, matrix: 400, directions: 2000 };
const WRITE_DEBOUNCE_MS = 500;

function normalizeAddress(a) {
	return String(a).trim().replace(/\s+/g, " ").toLowerCase();
}

function hash(input) {
	return crypto.createHash('sha1').update(input).digest('hex');
}

class CacheStore {
	constructor() {
		this.data = {};
		this.counters = {};
		this.dirty = false;
		this.timer = null;
		this.load();
	}

	load() {
		try {
			if (fs.existsSync(CACHE_PATH)) {
				this.data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
			}
		} catch (e) {
			console.error('[cache] failed to load cache, starting empty:', e.message);
			this.data = {};
		}
		for (const section of Object.keys(MAX)) {
			if (!this.data[section]) this.data[section] = {};
			this.counters[section] = { hits: 0, misses: 0 };
		}
		if (!this.data.lifetime || typeof this.data.lifetime !== "object") {
			this.data.lifetime = {};
		}
		for (const section of Object.keys(MAX)) {
			if (!this.data.lifetime[section]) this.data.lifetime[section] = { hits: 0, misses: 0 };
		}
	}

	get(section, key) {
		const entry = this.data[section][key];
		if (entry && entry.exp > Date.now()) {
			this.counters[section].hits++;
			this.data.lifetime[section].hits++;
			this.scheduleSave();
			return entry.v;
		}
		if (entry) delete this.data[section][key];
		this.counters[section].misses++;
		return undefined;
	}

	set(section, key, value) {
		this.data[section][key] = { v: value, ts: Date.now(), exp: Date.now() + TTL_MS };
		this.data.lifetime[section].misses++;
		this.prune(section);
		this.scheduleSave();
	}

	prune(section) {
		const store = this.data[section];
		const keys = Object.keys(store);
		const now = Date.now();
		let changed = false;
		for (const key of keys) {
			if (store[key].exp <= now) {
				delete store[key];
				changed = true;
			}
		}
		const remaining = Object.keys(store).length;
		if (remaining > MAX[section]) {
			const sorted = Object.keys(store)
				.map(key => ({ key, ts: store[key].ts }))
				.sort((a, b) => b.ts - a.ts);
			const toDrop = remaining - MAX[section];
			for (let i = toDrop - 1; i >= 0; i--) {
				delete store[sorted[sorted.length - 1 - i].key];
			}
			changed = true;
		}
		if (changed) this.scheduleSave();
	}

	scheduleSave() {
		this.dirty = true;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, WRITE_DEBOUNCE_MS);
	}

	flush() {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			const tmp = CACHE_PATH + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(this.data));
			fs.renameSync(tmp, CACHE_PATH);
		} catch (e) {
			console.error('[cache] failed to save cache:', e.message);
		}
	}

	snapshot() {
		const snap = {};
		for (const section of Object.keys(this.counters)) {
			snap[section] = { hits: this.counters[section].hits, misses: this.counters[section].misses };
		}
		return snap;
	}

	diff(before) {
		const out = [];
		for (const section of Object.keys(this.counters)) {
			const h = this.counters[section].hits - before[section].hits;
			const m = this.counters[section].misses - before[section].misses;
			out.push(`${section} ${h}/${m}`);
		}
		return out.join(" · ");
	}

	externalCalls(before) {
		let total = 0;
		for (const section of Object.keys(this.counters)) {
			total += this.counters[section].misses - before[section].misses;
		}
		return total;
	}

	savedCalls(before) {
		let total = 0;
		for (const section of Object.keys(this.counters)) {
			total += this.counters[section].hits - before[section].hits;
		}
		return total;
	}

	lifetimeReport() {
		const out = [];
		let total = 0;
		let saved = 0;
		for (const section of Object.keys(MAX)) {
			const t = this.data.lifetime[section];
			out.push(`${section} ${t.hits}/${t.misses}`);
			total += t.misses;
			saved += t.hits;
		}
		return out.join(" · ") + ` · external calls ${total}, saved ${saved}`;
	}
}

const cache = new CacheStore();

module.exports = { cache, normalizeAddress, hash, flush: () => cache.flush() };
