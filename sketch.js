// init global vars
let textboxes = [];
const n = 8;
let b, r, z;
let addresses;
let div1, div2, div3, inputDiv;
let map;
let initialized = false;
let unreachable;

function setup() {
	noCanvas();
	inputDiv = createDiv().id("inputContainer");
	createDiv().id("addresses").parent("inputContainer");
	for (let i = 0; i < n; i++) {
		textboxes.push(createInput(`Enter address ${i + 1}`));
		textboxes[i].parent("addresses");
		textboxes[i].class("InvalidAddress");
		textboxes[i].elt.addEventListener('click', clearField);
		textboxes[i].id("addr");
	}

	createP().parent("inputContainer")

	const pop_elt = "<select id='population'></select>";
	const acc_elt = "<select id='acc'></select>";
	const mr_elt = "<select id='mr'></select>";

	// Create dropdowns for population size, accuracy, mutation rate
	createDiv().id("modelParams").parent("inputContainer");
	createP("Genetic Algorithm Params: Population " + pop_elt + " Accuracy " + acc_elt + " Mutation Rate " + mr_elt).parent("modelParams");


	// Load options into DOM
	let popSizeOptions = [250, 500, 750, 1000, 1500, 2000]
	let accOptions = [250, 500, 750, 1000, 2500, 5000];
	let mrOptions = ['1%', '5%', '10%', '15%', '20%'];

	for (let i = 0; i < popSizeOptions.length; i++) {
		let option = document.createElement("option");
		option.text = popSizeOptions[i];
		document.getElementById("population").add(option);
	}

	for (let i = 0; i < accOptions.length; i++) {
		let option = document.createElement("option");
		option.text = accOptions[i];
		document.getElementById("acc").add(option);
	}

	for (let i = 0; i < mrOptions.length; i++) {
		let option = document.createElement("option");
		option.text = mrOptions[i];
		document.getElementById("mr").add(option);
	}

	createP().parent("inputContainer")

	// Create buttons

	createDiv().parent("inputContainer").id("buttons")

	b = createButton("Submit").class('left');
	b.elt.addEventListener("click", () => getAddress());
	b.parent("buttons");

	r = createButton("Reset").class('left');
	r.elt.addEventListener("click", () => resetAll());
	r.parent("buttons");

	z = createButton("Ctrl-C + Reset").class('left');
	z.elt.addEventListener("click", () => location.reload());
	z.parent("buttons");
}

function resetAll() {
	// 1. Re-intialize text in input boxes
	for (let i = 0; i < n; i++) {
		textboxes[i].elt.value = `Enter address ${i + 1}`;
		textboxes[i].class("InvalidAddress");
	}
}

function clearField(e) {
	e.target.value = "";
	e.target.className = "InvalidAddress";
}

function getAddress() {
	start_tsp = true;

	// 1. Read addresses from input boxes
	addresses = [];
	for (let i = 0; i < textboxes.length; i++) {
		const addr = textboxes[i].value();
		addresses.push(addr);
	}

	const all_invalid = (addresses.map(x => (/enter address \d+/i).test(x))).every(x => x);

	if (all_invalid) {
		console.log("Enter at least 1 address");
	} else {

		// 2. get their lat and lng from Google's API
		let promises = [];
		for (let i = 0; i < addresses.length; i++) {
			promises.push(getCoords(addresses[i]));
		}

		Promise.all(promises)
			.then(returned_data => {

				// 2.1 Create copy of returned results
				let cities = returned_data.slice();

				// 2.2 Removed invalid addresses
				for (let i = cities.length - 1; i >= 0; i--) {
					textboxes[i].class(returned_data[i].class);
					if (!cities[i].address) {
						cities.splice(i, 1);
					}
				}
				let distMatrix = [];
				console.log('Building distance matrix');

				getDistFromDistAPI(cities)
					.then(obj => {
						for (let i = 0; i < cities.length; i++) {
							let temp = [];
							let destinations = obj.rows[i].elements;
							for (let j = 0; j < destinations.length; j++) {
								if (destinations[j].status == 'OK') {
									temp.push(destinations[j].distance.value / 1600);
								} else {
									temp.push(Infinity);
								}
							}
							distMatrix.push(temp);
						}

						console.table(distMatrix);

						// Check if any cities are unreachable
						unreachable = [];
						for (let i = 0; i < distMatrix.length; i++) {
							let temp = distMatrix[i].slice()
							temp.splice(i, 1);
							if (temp.every(val => val == Infinity)) {
								unreachable.push(i)
								console.log(`${cities[i].address} is unreachable`);
							}
						}

						// Create map
						if (!initialized) {
							createDiv().attribute("id", "googlemap");
							div1 = createDiv();
							div2 = createDiv();
							div3 = createDiv();
							initialized = true;
						}

						let pos
						// The location of the center of the US
						pos = { lat: 44.967243, lng: -103.771556 };

						map = new google.maps.Map(document.getElementById("googlemap"), {
							zoom: 4,
							center: pos,
							mapTypeId: "roadmap",
						});

						// 2.5 Draw addresses on map 
						let centroid = createVector();
						for (let i = 0; i < cities.length; i++) {
							city = cities[i];

							// Adjust color and radius if city is unreachable

							let color = (unreachable.some(val => val == i)) ? "#FF8C00" : "#FF0000";
							let radius = (unreachable.some(val => val == i)) ? 15000 : 3000;

							// Add the circle for this city to the map.
							const cityCircle = new google.maps.Circle({
								strokeColor: color,
								strokeOpacity: 0.8,
								strokeWeight: 2,
								fillColor: color,
								fillOpacity: 0.35,
								map,
								center: city.coords,
								radius: radius,
							});
							
							city.circle = cityCircle;       // store reference
							city.baseRadius = radius;   // store base radius

							let city_v = createVector(city.coords.lng, city.coords.lat);
							centroid.add(city_v);
						}
						centroid.mult(1 / cities.length);
						map.setCenter({ lat: centroid.y, lng: centroid.x });
						map.setZoom(8);

						// Function to safely scale circles based on zoom
						function updateCircleRadius() {
							const zoom = map.getZoom();
							cities.forEach(city => {
								if (city.circle) { // safety check
									const scaledRadius = city.baseRadius / Math.pow(2, zoom - 8);
									city.circle.setRadius(scaledRadius);
								}
							});
						}

						// Update radius whenever zoom changes
						map.addListener("zoom_changed", updateCircleRadius);

						// Initial scaling
						updateCircleRadius();

						if (unreachable.length == 0) {
							solveTSP(cities, distMatrix);
						}
					})
			})
			.catch(err => console.error(err));
	}
}

function solveTSP(cities, distMatrix) {
	// 4. Run GA and get optimal TSP
	let route = getBestRoute(cities, distMatrix);

	console.log("Best route is " + route)
	let s = ""
	for (let i = 0; i <= route.length; i++) {
		if (i == route.length) {
			s += `${cities[route[i % route.length]].address}`;
		} else {
			s += `${cities[route[i % route.length]].address} -> `;
		}
	}
	div3.html(s);

	// 5. Get coordinates for round trip
	let promises2 = [];
	for (let i = 0; i < route.length; i++) {
		let f = cities[route[i]];
		let t = cities[route[(i + 1) % route.length]];

		promises2.push(fetchSegData(f, t));
	}

	// 6. Draw on map

	Promise.all(promises2)
		.then(results => {
			let driving_dist = 0;
			for (const result of results) {
				// console.log(result);

				driving_dist += result.seg_dist_m;

				const segment = new google.maps.Polyline({
					path: result.segment,
					geodesic: true,
					strokeColor: "#FF0000",
					strokeOpacity: 1.0,
					strokeWeight: 2,
				});
				segment.setMap(map);

				// 6.1 Add a listener event to the polyline to display distance
				const infowindow = new google.maps.InfoWindow({
					content: `${result.origin.address} -> ${result.destination.address} : ${(result.seg_dist_m / 1600).toFixed(2)} mi.`,
				});

				const polyline_center = result.segment[floor(result.segment.length / 2)];
				segment.addListener("click", (e) => {
					// map.setZoom(15);
					// map.setCenter(polyline_center);
					const clickPoint = e.latLng.toJSON();
					infowindow.setPosition(clickPoint);
					infowindow.open(map);
				});
			}
			div2.html(`Total driving distance: ${nf(driving_dist / 1600, 0, 2)}`);
		})
		.catch(err => console.log(err));
	console.log("DONE!!");
}

function fetchSegData(f, t) {
	const directionsService = new google.maps.DirectionsService();
	const request = {
		origin: f.address,
		destination: t.address,
		travelMode: 'DRIVING'
	};

	return new Promise((resolve, reject) => {

		directionsService.route(request, (result, status) => {
			if (status == 'OK') {
				const steps = result.routes[0].legs[0].steps;
				const seg_dist = result.routes[0].legs[0].distance.text;
				const seg_dist_m = float(result.routes[0].legs[0].distance.value);
				let seg = [];
				for (step of steps) {
					const points = decode(step.polyline.points);
					for (let i = 0; i < points.length; i++) {
						seg.push({
							lat: points[i][0],
							lng: points[i][1],
						})
					}
				}
				resolve({
					seg_dist: seg_dist,
					seg_dist_m: seg_dist_m,
					segment: seg,
					origin: f,
					destination: t,
				});
			} else {
				reject(new Error("Something went wrong getting the segment details"));
			}
		});
	});
}

async function getRoute(city1, city2) {
	console.log(city1, city2);
	const url_route = 'https://maps.googleapis.com/maps/api/directions/json?key=<YOUR-GOOGLE-DIRECTIONS-API>&origin=place_id:' + city1.placeID + '&destination=place_id:' + city2.placeID;
	const response_route = await fetch(url_route);
	const data = await response_route.json();
	const encoded = data.routes[0].overview_polyline.points;
	const decoded = decode(encoded, 5);
	return {
		from: city1,
		to: city2,
		latlng: decoded,
	};
}

async function getCoords(address) {
	const invalidObj = {
		address: undefined,
		coords: undefined,
		placeID: undefined,
		class: "InvalidAddress",
	}
	if (/^\s*$/.test(address)) {
		return invalidObj;
	}
	const url_address = "https://maps.googleapis.com/maps/api/geocode/json?key=<YOUR-GOOGLE-GEOCODE-API>&address=" + address;
	const response_placeID = await fetch(url_address);
	const data = await response_placeID.json();
	if (data.results.length == 0) {
		return invalidObj;
	} else {
		const coords = data.results[0].geometry.location;
		const placeID = data.results[0].place_id;
		return {
			address: address,
			coords: coords,
			placeID: placeID,
			class: "ValidAddress",
		};
	}
}

function getBestRoute(cities, distMatrix) {

	// Initialize orrder and recordDist
	let recordDist = Infinity;
	let order = [];
	let howlong = 1;

	for (let i = 0; i < cities.length; i++) {
		order[i] = i;
	}

	// Initialize Population
	let selPop = document.getElementById("population").options.selectedIndex;
	let N = parseInt(document.getElementById("population").options[selPop].value, 10);

	let population = [];
	for (let i = 0; i < N; i++) {
		population[i] = shuffle(order);
	}

	// Initialize bestOrder
	let bestOrder = order;

	// Run for selected generations
	let selAcc = document.getElementById("acc").options.selectedIndex;
	let gen = parseInt(document.getElementById("acc").options[selAcc].value, 10);

	// Get mutation rate
	let selMr = document.getElementById("mr").options.selectedIndex;
	let mutationRate = parseFloat(document.getElementById("mr").options[selMr].value.match(/\d+/g)[0]) / 100;

	order = [];

	while (howlong <= gen) {
		// Implement genetic alorithm
		let fitness = calcFitness(population, distMatrix);
		order = population[bestOrderIndex(fitness)];
		if (calcDist(order, distMatrix) < recordDist) {
			console.log(`Found new best route`);
			howlong = 1;
			recordDist = calcDist(order, distMatrix);
			bestOrder = order;
		}
		let s = `Best distance: ${nf(recordDist, 0, 2)}; for ${howlong} generations`;
		div1.html(s);
		population = crossOver(mutationRate, population, fitness);

		howlong++;
	}
	return bestOrder;
}

function calcDist(order, distMatrix) {
	let sum = 0;

	for (let i = 0; i < order.length; i++) {
		sum += distMatrix[order[i]][order[(i + 1) % order.length]];
	}
	return sum;
}

function calcFitness(population, distMatrix) {
	let fitness = [];
	for (let i = 0; i < population.length; i++) {
		let d = calcDist(population[i], distMatrix);
		let score = pow(2, -d / 100)
		fitness.push(score);
	}
	let den = fitness.reduce((a, b) => a + b, 0);
	for (let i = 0; i < fitness.length; i++) {
		fitness[i] = fitness[i] / den;
	}

	return fitness;
}

function crossOver(mutationRate, population, fitness) {
	let newPop = []
	for (let j = 0; j < population.length; j++) {
		let newGenes = [];
		let a = sample(fitness);
		let b = sample(fitness);
		let geneA = population[a];
		let geneB = population[b];
		let start = floor(random(geneA.length));
		let end = floor(random(start + 1, geneA.length));
		let subSet = geneA.slice(start, end);
		newGenes = newGenes.concat(subSet);
		for (let i = 0; i < geneB.length; i++) {
			if (!newGenes.includes(geneB[i])) {
				newGenes.push(geneB[i])
			}
		}
		// Mutate
		if (random(1) < mutationRate) {
			let u = floor(random(newGenes.length));
			let v = floor(random(newGenes.length));
			swap(newGenes, u, v);
		}
		newPop.push(newGenes);
	}
	return newPop;
}

function sample(fitness) {
	let cumDist = fitness.map((sum = 0, n => sum += n));
	let r = random(1);
	for (let i = 0; i < cumDist.length; i++) {
		if (r < cumDist[i]) {
			return i;
		}
	}
}

function bestOrderIndex(fitness) {
	let best = 0;
	let bestIndex = -1;
	for (let i = 0; i < fitness.length; i++) {
		if (fitness[i] > best) {
			bestIndex = i;
		}
	}
	return bestIndex;
}

function swap(arr, i, j) {
	let temp = arr[i];
	arr[i] = arr[j];
	arr[j] = temp;
}


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

function calcRoute() {
	var start = document.getElementById('start').value;
	var end = document.getElementById('end').value;
	var request = {
		origin: start,
		destination: end,
		travelMode: 'DRIVING'
	};
	directionsService.route(request, function (result, status) {
		if (status == 'OK') {
			directionsRenderer.setDirections(result);
		}
	});
}

const getDistFromDistAPI = function (cities) {
	let origins = [];
	for (city of cities) {
		origins.push(city.address);
	}
	return new Promise((resolve, reject) => {
		let service = new google.maps.DistanceMatrixService();
		service.getDistanceMatrix(
			{
				origins: origins,
				destinations: origins,
				travelMode: 'DRIVING',
				unitSystem: google.maps.UnitSystem.METRIC,
				avoidHighways: false,
				avoidTolls: false,
			}, ((response, status) => {
				if (status == 'OK') {
					resolve(response);
				} else {
					reject(new Error(status));
				}
			}));
	});
}