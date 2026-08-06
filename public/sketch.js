// init global vars
let textboxes = [];
const n = 10;
let addresses;
let unreachable;
let tsp;
let curr_layer;
let interim;
let interimFitted = false;
let socket;
let socketID;
let currentUnit = "mi";
let currentMetric = "distance";
let solvedOnce = false;

function setup() {
	socket = io(); // same-origin: connects to whatever host/port is serving this page

	// Get it immediately when connected
	socket.on('connect', () => {
		socketID = socket.id;
	});

	// Listen for per-address geocode results
	socket.on('geocode-progress', (data) => {
		if (textboxes[data.index]) textboxes[data.index].className = data.className;
	});

	// Listen for generation progress
	socket.on('generation-progress', (data) => {
		const bar = document.getElementById("pbar");
		const label = document.getElementById("plabel");
		if (bar && label) {
			bar.style.width = (data.progress * 100).toFixed(1) + "%";
			const div = Math.max(1, data.diversity || 0);
			label.textContent = Math.round(data.progress * 100) + "% · div " + div;
		}
		const live = document.getElementById("liveDist");
		if (live && data.diversity !== undefined) {
			const stag = data.stagnation || 0;
			live.textContent = `Stagnation: ${stag}  ·  Diversity: ${data.diversity}/${data.popSize}`;
			live.removeAttribute("hidden");
		}
	});

	// Listen for interim best-route updates while solving
	socket.on('route-update', (data) => {
		drawInterim(data.coords, data.recordDist);
		const live = document.getElementById("liveDist");
		if (live) {
			const distText = currentMetric === "duration"
				? formatDuration(data.recordDist)
				: formatDist(data.recordDist, currentUnit);
			live.textContent = `Best so far: ${distText}`;
			live.removeAttribute("hidden");
		}
	});

	// Build address rows into the grid
	const grid = document.getElementById("addrGrid");
	for (let i = 0; i < n; i++) {
		const row = document.createElement("div");
		row.className = "addr-row";

		const num = document.createElement("div");
		num.className = "num";
		num.textContent = i + 1;

		const input = document.createElement("input");
		input.placeholder = "Enter address " + (i + 1);
		input.className = "InvalidAddress";
		input.addEventListener("click", clearField);

		row.append(num, input);
		grid.appendChild(row);
		textboxes.push(input);
	}

	// Address entry mode toggle (manual vs upload)
	window.setAddrMode = (mode) => {
		const manual = mode === "manual";
		document.getElementById("segManual").classList.toggle("active", manual);
		document.getElementById("segUpload").classList.toggle("active", !manual);
		document.getElementById("manualPane").classList.toggle("hidden", !manual);
		document.getElementById("uploadPane").classList.toggle("hidden", manual);
	};

	// Info popover for upload format
	const infoIcon = document.getElementById("infoIcon");
	const infoPop = document.getElementById("infoPop");
	infoIcon.addEventListener("click", (e) => {
		e.stopPropagation();
		infoPop.classList.toggle("open");
	});
	document.addEventListener("click", (e) => {
		if (infoPop && !infoPop.contains(e.target)) infoPop.classList.remove("open");
	});

	// File upload: one address per line, no headers, max 10
	const dropzone = document.getElementById("dropzone");
	const fileInput = document.getElementById("fileInput");
	const uploadNote = document.getElementById("uploadNote");

	dropzone.addEventListener("click", () => fileInput.click());

	// Drag & drop support
	["dragenter", "dragover"].forEach(ev => {
		dropzone.addEventListener(ev, (e) => {
			e.preventDefault();
			e.stopPropagation();
			dropzone.classList.add("dragover");
		});
	});
	["dragleave", "drop"].forEach(ev => {
		dropzone.addEventListener(ev, (e) => {
			e.preventDefault();
			e.stopPropagation();
			dropzone.classList.remove("dragover");
		});
	});
	dropzone.addEventListener("drop", (e) => {
		const file = e.dataTransfer.files[0];
		if (file) handleFile(file);
	});

	fileInput.addEventListener("change", (e) => {
		const file = e.target.files[0];
		if (file) handleFile(file);
	});

	function handleFile(file) {
		const reader = new FileReader();
		reader.onload = () => {
			const lines = reader.result
				.split(/\r?\n/)
				.map(l => l.trim())
				.filter(l => l.length > 0);

			if (lines.length > n) {
				uploadNote.textContent = "File has " + lines.length + " addresses — max is " + n + ". Nothing loaded.";
				uploadNote.className = "upload-note error";
				return;
			}

			for (let i = 0; i < n; i++) {
				textboxes[i].value = lines[i] || "";
				textboxes[i].className = "InvalidAddress";
			}
			// Clear stale results and route after loading a new list
			flushResults();
			if (curr_layer) {
				curr_layer.removeFrom(tsp);
				curr_layer = null;
			}
			clearInterim();
			uploadNote.textContent = lines.length > 0 ? "Loaded " + lines.length + " address" + (lines.length === 1 ? "" : "es") : "";
			uploadNote.className = "upload-note";
			// Switch to the manual pane so the uploaded addresses are visible
			setAddrMode("manual");
		};
		reader.readAsText(file);
		fileInput.value = "";
	}

	// Populate GA parameter dropdowns
	let popSizeOptions = [250, 500, 750, 1000, 1500, 2000];
	let accOptions = [250, 500, 750, 1000, 2500, 5000];
	let mrOptions = ['1%', '5%', '10%', '15%', '20%'];

	const popSelect = document.getElementById("population");
	const accSelect = document.getElementById("acc");
	const mrSelect = document.getElementById("mr");

	for (let i = 0; i < popSizeOptions.length; i++) {
		let option = document.createElement("option");
		option.text = popSizeOptions[i];
		popSelect.add(option);
	}
	popSelect.selectedIndex = 1; // default 500

	for (let i = 0; i < accOptions.length; i++) {
		let option = document.createElement("option");
		option.text = accOptions[i];
		accSelect.add(option);
	}
	accSelect.selectedIndex = 1; // default 500

	for (let i = 0; i < mrOptions.length; i++) {
		let option = document.createElement("option");
		option.text = mrOptions[i];
		mrSelect.add(option);
	}

	// Initialize map
	tsp = L.map('map').setView([0, 0], 2);

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		opacity: 1,
		attribution: '© OpenStreetMap',
		renderer: L.canvas()
	}).addTo(tsp);

	// Resizable panel with persisted size
	const MIN_W = 300;
	const MIN_H = 320;
	const STORE_KEY = 'tspPanelSize';

	const panel = document.querySelector('.panel');
	const handle = document.getElementById('resizeHandle');

	const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

	const restorePanelSize = () => {
		try {
			const saved = JSON.parse(localStorage.getItem(STORE_KEY));
			if (saved && saved.w && saved.h) {
				const maxW = window.innerWidth - 32;
				const maxH = window.innerHeight - 32;
				panel.style.width = clamp(saved.w, MIN_W, maxW) + 'px';
				panel.style.height = clamp(saved.h, MIN_H, maxH) + 'px';
			}
		} catch (e) { /* ignore corrupt storage */ }
	};

	restorePanelSize();

	if (handle) {
		let startX, startY, startW, startH;
		const onMove = (e) => {
			const maxW = window.innerWidth - 32;
			const maxH = window.innerHeight - 32;
			panel.style.width = clamp(startW + (startX - e.clientX), MIN_W, maxW) + 'px';
			panel.style.height = clamp(startH + (e.clientY - startY), MIN_H, maxH) + 'px';
		};
		const onUp = (e) => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			localStorage.setItem(STORE_KEY, JSON.stringify({
				w: panel.offsetWidth,
				h: panel.offsetHeight
			}));
		};
		handle.addEventListener('mousedown', (e) => {
			e.preventDefault();
			startX = e.clientX;
			startY = e.clientY;
			startW = panel.offsetWidth;
			startH = panel.offsetHeight;
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		});
	}
}

function resetAll() {
	// 1. Re-initialize text in input boxes
	for (let i = 0; i < n; i++) {
		textboxes[i].value = "";
		textboxes[i].className = "InvalidAddress";
	}

	// 1b. Reset avoid toggles to allowed (both off)
	["tolls", "ferries"].forEach(v => {
		const el = document.getElementById("avoid-" + v);
		if (el) el.checked = false;
	});

	// 2. Clear route layer from the map
	if (curr_layer) {
		curr_layer.removeFrom(tsp);
		curr_layer = null;
	}
	clearInterim();

	flushResults();
	resetProgress();
}

function clearField(e) {
	e.target.value = "";
	e.target.className = "InvalidAddress";
}

function setUnits(u) {
	currentUnit = u;
	document.getElementById("unitMi").classList.toggle("active", u === "mi");
	document.getElementById("unitKm").classList.toggle("active", u === "km");
}

function setObjective(o) {
	currentMetric = o;
	document.getElementById("objDistance").classList.toggle("active", o === "distance");
	document.getElementById("objDuration").classList.toggle("active", o === "duration");
	if (solvedOnce) getAddress();
}

function formatDuration(s) {
	s = Math.max(0, Math.round(s || 0));
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	if (h > 0) {
		return h + " h" + (m > 0 ? " " + m + " min" : "");
	}
	return m + " min";
}

function formatDist(meters, unit) {
	const value = unit === "km" ? meters / 1000 : meters / 1609.344;
	return value.toLocaleString(undefined, { maximumFractionDigits: 1 }) + (unit === "km" ? " km" : " mi");
}

function clearInterim() {
	if (interim) {
		interim.removeFrom(tsp);
		interim = null;
	}
	interimFitted = false;
	const live = document.getElementById("liveDist");
	if (live) live.classList.add("hidden");
}

function drawInterim(coords, recordDist) {
	if (interim) interim.removeFrom(tsp);

	const points = coords.filter(c => c && c.lat !== undefined && c.lng !== undefined)
		.map(c => [c.lat, c.lng]);

	const tour = points.length > 0 ? points.concat([points[0]]) : [];

	const layer = [];
	for (const [lat, lng] of points) {
		layer.push(L.circleMarker([lat, lng], {
			radius: 5,
			color: '#5f6368',
			weight: 1,
			fillColor: '#5f6368',
			fillOpacity: 1,
		}));
	}
	layer.push(L.polyline(tour, {
		color: '#1a73e8',
		weight: 2,
		opacity: 0.7,
		dashArray: '6 6',
	}));

	interim = L.layerGroup(layer);
	if (interim != null) interim.addTo(tsp);

	if (!interimFitted && points.length > 0) {
		tsp.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
		interimFitted = true;
	}

	const live = document.getElementById("liveDist");
	if (live) {
		live.textContent = currentMetric === "duration"
			? "Best time so far: " + formatDuration(recordDist)
			: "Best so far: " + formatDist(recordDist * 1609.344, currentUnit);
		live.classList.remove("hidden");
	}
}

function buildCityMarkers(coords, unreachableCoords = [], markStart = true) {
	const markers = [];
	const isUnreachable = p => unreachableCoords.some(u => u && u.lat === p.lat && u.lng === p.lng);
	let k = 0;
	for (const p of coords) {
		if (!p) continue;
		const cls = 'num-circle' + (markStart && p.idx === 0 ? ' start' : '') + (isUnreachable(p) ? ' unreachable' : '');
		markers.push(L.marker([p.lat, p.lng], {
			icon: L.divIcon({
				className: cls,
				html: `<span>${(p.idx != null ? p.idx : k) + 1}</span>`,
				iconSize: [24, 24],
			}),
		}));
		k++;
	}
	return markers;
}

function resetProgress() {
	const bar = document.getElementById("pbar");
	const label = document.getElementById("plabel");
	if (bar) bar.style.width = "0%";
	if (label) label.textContent = "Idle";
	document.getElementById("submit").disabled = false;
}

function flushResults() {
	const section = document.getElementById("resultsSection");
	if (section) section.classList.add("hidden");
	document.getElementById("segments").innerHTML = "";
	const ferryNote = document.getElementById("ferryNote");
	if (ferryNote) ferryNote.classList.add("hidden");
	const unreachableNote = document.getElementById("unreachableNote");
	if (unreachableNote) unreachableNote.classList.add("hidden");
	solvedOnce = false;
}

async function getAddress() {
	flushResults();
	resetProgress();
	clearInterim();

	// 1. Read addresses from input boxes
	addresses = [];
	for (let i = 0; i < textboxes.length; i++) {
		const addr = textboxes[i].value;
		addresses.push(addr);
	}

	const filled = addresses.filter(a => !/(enter address \d+)|(^\s*$)/i.test(a)).length;

	if (filled < 3) {
		document.getElementById("submit").disabled = false;
		document.getElementById("population").disabled = false;
		document.getElementById("acc").disabled = false;
		document.getElementById("mr").disabled = false;
		document.getElementById("plabel").textContent = "Need ≥3 valid";
		return;
	}

	// Post addresses and model params to API
	const submitBtn = document.getElementById("submit");
	submitBtn.disabled = true;
		document.getElementById("population").disabled = true;
		document.getElementById("acc").disabled = true;
		document.getElementById("mr").disabled = true;
		document.getElementById("plabel").textContent = "Solving…";

		// Get selected population
		let N = parseInt(document.getElementById("population").value, 10);

		// Get selected generations
		let gen = parseInt(document.getElementById("acc").value, 10);

		// Get selected mutation rate
		let mutationRate = parseFloat(document.getElementById("mr").value.match(/\d+/g)[0]) / 100;

		payload = {
			addresses: addresses,
			N: N,
			accuracy: gen,
			muRate: mutationRate,
			avoid: ["tolls", "ferries"].filter(v => document.getElementById("avoid-" + v).checked),
			socketID: socketID,
			metric: currentMetric
		};

		options = {
			method: "POST",
			body: JSON.stringify(payload),
			headers: {
				'Content-Type': 'application/json'
			},
		}
		response = await fetch("/addresses", options);
		data = await response.json();
		for (let i = data.css.length - 1; i >= 0; i--) {
			textboxes[i].className = data.css[i];
		}
		console.log(data);

		if (data.unreachable && data.unreachable.length > 0) {
			document.getElementById("dist").textContent = "—";
			document.getElementById("genAt").textContent = "—";
			document.getElementById("unreachableNote").textContent = "Cannot find a road route to: " + data.unreachable.join(", ");
			document.getElementById("unreachableNote").classList.remove("hidden");
			document.getElementById("resultsSection").classList.remove("hidden");
			document.getElementById("plabel").textContent = "Unreachable";
			document.getElementById("submit").disabled = false;
			document.getElementById("population").disabled = false;
			document.getElementById("acc").disabled = false;
			document.getElementById("mr").disabled = false;
			const animBtn = document.getElementById("animBtn");
			if (animBtn) animBtn.setAttribute("hidden", "");

			clearInterim();
			if (curr_layer) {
				curr_layer.removeFrom(tsp);
			}
			const numMarkers = buildCityMarkers(data.coords, data.unreachableCoords, false);
			const valid = data.coords.filter(Boolean);
			curr_layer = L.layerGroup(numMarkers);
			curr_layer.addTo(tsp);
			if (valid.length > 0) {
				tsp.fitBounds(L.latLngBounds(valid.map(p => [p.lat, p.lng])), { padding: [40, 40] });
			}
			return;
		}

		// Extract latlng coordinates for the round trip
		let paths = [];
		for (let route of data.routes) {
			const origin = route.routes[0].legs[0].start_address;
			const destination = route.routes[0].legs[0].end_address;
			const steps = route.routes[0].legs[0].steps;
			const seg_dist_m = float(route.routes[0].legs[0].distance.value);
			const seg_dur_s = route.routes[0].legs[0].duration.value;

			let seg = [];
			let ferryStep = null;
			for (step of steps) {
				const points = decode(step.polyline.points);
				seg = seg.concat(points);
				if (!ferryStep && (step.maneuver === "ferry" || step.maneuver === "ferry_train" || step.travel_mode === "FERRY")) {
					ferryStep = step;
				}
			}

			let path = {
				seg_dist_m: seg_dist_m,
				seg_dur_s: seg_dur_s,
				coords: seg,
				origin: origin,
				destination: destination,
				ferry: !!ferryStep,
				ferryStart: ferryStep ? { lat: ferryStep.start_location.lat, lng: ferryStep.start_location.lng } : null,
			}
			paths.push(path);
		}
console.log(paths);

		clearInterim();

		// Get total distance
		const ferriesDisallowed = payload.avoid.includes("ferries");
		let sumDist = 0;
		let sumDur = 0;
		let ferryLegs = 0;
		for (let i = 0; i < paths.length; i++) {
			const p1 = paths[i % paths.length];
			const p2 = paths[(i + 1) % paths.length];
			sumDist += p1.seg_dist_m;
			sumDur += p1.seg_dur_s;
			const li = document.createElement("li");
			const step = document.createElement("span");
			step.className = "step";
			step.textContent = `Segment ${i + 1}`;
			if (p1.ferry) {
				const ferry = document.createElement("span");
				ferry.className = "ferry-badge";
				ferry.textContent = " (ferry)";
				ferry.title = ferriesDisallowed ? "Still includes a ferry despite Avoid ferries being on" : "Route includes a ferry";
				step.append(ferry);
				li.classList.add("ferry-leg");
				ferryLegs++;
			}
			step.append(`: ${p1.origin} → ${p2.origin}`);
			const dist = document.createElement("span");
			dist.className = "dist";
			dist.textContent = formatDist(p1.seg_dist_m, currentUnit) + " · " + formatDuration(p1.seg_dur_s);
			li.append(step, dist);
			document.getElementById("segments").appendChild(li);
		}

		// Populate results section
		document.getElementById("objLabel").textContent = currentMetric === "duration" ? "Optimal time" : "Optimal distance";
		document.getElementById("dist").textContent = currentMetric === "duration" ? formatDuration(sumDur) : formatDist(sumDist, currentUnit);
		document.getElementById("genAt").textContent = data.bestGen ? "gen " + data.bestGen : "—";
		document.getElementById("resultsSection").classList.remove("hidden");
		solvedOnce = true;
		const ferryNote = document.getElementById("ferryNote");
		if (ferryNote) {
			if (ferriesDisallowed && ferryLegs > 0) {
				ferryNote.textContent = `⚠ ${ferryLegs} segment${ferryLegs > 1 ? "s" : ""} still use a ferry despite Avoid ferries being on`;
				ferryNote.classList.remove("hidden");
			} else {
				ferryNote.classList.add("hidden");
			}
		}
		document.getElementById("plabel").textContent = "Done";
		document.getElementById("submit").disabled = false;
		document.getElementById("population").disabled = false;
		document.getElementById("acc").disabled = false;
		document.getElementById("mr").disabled = false;

		// Show animate button
		const animBtn = document.getElementById("animBtn");
		if (animBtn) animBtn.removeAttribute("hidden");

		// Store route data for animation
		_lastPaths = paths;

		// Draw cities and TSP on the map
		if (curr_layer) {
			curr_layer.removeFrom(tsp);
		}

		let polylines = [];
		let ferryMarkers = [];
		for (let i = 0; i < paths.length; i++) {
			const col = paths[i].ferry ? '#FF6F00' : '#283593';
			// glow layer — wide, faint, behind the main line
			polylines.push(L.polyline(paths[i].coords, {
				color: col, weight: 6, opacity: 0.12, className: 'route-glow',
			}));
			polylines.push(L.polyline(paths[i].coords, {
				color: col, opacity: 0.6, weight: 2, dashArray: '8, 8',
			}));
			if (paths[i].ferry) {
				const start = paths[i].ferryStart;
				ferryMarkers.push(L.marker([start.lat, start.lng], {
					icon: L.divIcon({
						className: 'ferry-icon',
						html: '⛴',
						iconSize: [18, 18],
					}),
				}));
			}
		}

		let numMarkers = buildCityMarkers(data.ordered);

		curr_layer = L.layerGroup(polylines.concat(ferryMarkers).concat(numMarkers));
		curr_layer.addTo(tsp);

		if (data.ordered.length > 0) {
			tsp.fitBounds(L.latLngBounds(data.ordered.map(p => [p.lat, p.lng])), { padding: [40, 40] });
		}

}


// -- globals for animation + compare ------------------------------------
let _lastPaths = null;
let _animMarker = null;
let _animTimer = null;

function startRouteAnimation() {
	if (!_lastPaths || _lastPaths.length === 0) return;
	if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }

	const allCoords = _lastPaths.flatMap(p => p.coords);
	if (allCoords.length < 2) return;

	const btn = document.getElementById("animBtn");
	const origLabel = "Animate route";
	if (btn) btn.textContent = "Replay";

	if (_animMarker) { _animMarker.removeFrom(tsp); _animMarker = null; }

	let idx = 0;
	_animMarker = L.circleMarker(allCoords[0], {
		radius: 7,
		color: '#1a73e8',
		fillColor: '#1a73e8',
		fillOpacity: 0.9,
		weight: 3,
		opacity: 0.5,
	}).addTo(tsp);

	const totalFrames = 1800;
	const perFrame = Math.ceil(allCoords.length / totalFrames) || 1;

	_animTimer = setInterval(() => {
		idx += perFrame;
		if (idx >= allCoords.length) {
			idx = 0;
			if (btn) btn.textContent = origLabel;
			clearInterval(_animTimer);
			_animTimer = null;
		}
		_animMarker.setLatLng(allCoords[idx]);
	}, 1000 / 60);
}

function stopRouteAnimation() {
	if (_animTimer) { clearInterval(_animTimer); _animTimer = null; }
	if (_animMarker) { _animMarker.removeFrom(tsp); _animMarker = null; }
	const btn = document.getElementById("animBtn");
	if (btn) btn.textContent = "Animate route";
}


(function () {
	const origReset = window.resetAll;
	window.resetAll = function () {
		stopRouteAnimation();
		_lastPaths = null;
		const animBtn = document.getElementById("animBtn");
		if (animBtn) animBtn.setAttribute("hidden", "");
		document.getElementById("liveDist").setAttribute("hidden", "");
		if (origReset) origReset();
	};
})();


const decode = function (encodedPath, precision = 5) {
	const factor = Math.pow(10, precision);

	const len = encodedPath.length;

	// For speed we preallocate to an upper bound on the final length, then
	// truncate the array before returning.
	const path = new Array(Math.floor(encodedPath.length / 2));
	let index = 0;
	let lat = 0;
	let lng = 0;
	let pointIndex = 0;

	// This code has been profiled and optimized, so don't modify it without
	// measuring its performance.
	for (; index < len; ++pointIndex) {
		// Fully unrolling the following loops speeds things up about 5%.
		let result = 1;
		let shift = 0;
		let b;
		do {
			// Invariant: "result" is current partial result plus (1 << shift).
			// The following line effectively clears this bit by decrementing "b".
			b = encodedPath.charCodeAt(index++) - 63 - 1;
			result += b << shift;
			shift += 5;
		} while (b >= 0x1f); // See note above.
		lat += result & 1 ? ~(result >> 1) : result >> 1;

		result = 1;
		shift = 0;
		do {
			b = encodedPath.charCodeAt(index++) - 63 - 1;
			result += b << shift;
			shift += 5;
		} while (b >= 0x1f);
		lng += result & 1 ? ~(result >> 1) : result >> 1;

		path[pointIndex] = [lat / factor, lng / factor];
	}
	// truncate array
	path.length = pointIndex;

	return path;
}
