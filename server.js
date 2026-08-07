const { Client } = require("@googlemaps/google-maps-services-js");
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { cache, normalizeAddress, hash, flush: flushCache } = require('./cache');
const app = express();
const port = process.env.PORT || 5555;

const LOG_PATH = path.join(__dirname, 'api_cache.log');

function logLine(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    console.log(line);
    try {
        fs.appendFileSync(LOG_PATH, line + "\n");
    } catch (e) {
        console.error('[log] failed to write log file:', e.message);
    }
}

process.on('SIGINT', () => { flushCache(); process.exit(0); });
process.on('SIGTERM', () => { flushCache(); process.exit(0); });

require('dotenv').config();

const client = new Client({});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: "1mb" }));

const server = app.listen(port, () => {
    console.log(`TSP app listening at http://localhost:${port} (and on the LAN)`);
    logLine(`server started · restored cache lifetime · ${cache.lifetimeReport()}`);
});


const socket = require('socket.io');
const io = socket(server, {
    cors: {
        origin: true, // Reflect the requesting client's origin (works on localhost / LAN / any host)
        methods: ["GET", "POST"],
        credentials: true
    }
});

const connectedSockets = new Map(); // socket.id -> socket object

io.sockets.on('connection', (socket) => {
    console.log(`Connected to: ${socket.id}`);
    // Store the socket
    connectedSockets.set(socket.id, socket);

    // Clean up when socket disconnects (ADD THIS)
    socket.on('disconnect', () => {
        console.log(`Disconnected from: ${socket.id}`);
        connectedSockets.delete(socket.id);
    });
});


app.post('/addresses', async (request, response) => {
    console.log(request.body);
    const addresses = request.body.addresses;
    const N = request.body.N;
    const acc = request.body.accuracy;
    const mutationRate = request.body.muRate;
    const socketID = request.body.socketID;
    const avoid = request.body.avoid || [];
    const metric = request.body.metric || "distance";
    const cacheBefore = cache.snapshot();

    let cities;
    let css = [];
    let coords = [];
    let distMatrix = [];
    let durationMatrix = [];

    let promises = [];
    for (let i = 0; i < addresses.length; i++) {
        promises.push(getCoords(addresses[i]));
    }
    promises = await Promise.all(promises.map(async (p, i) => {
        const res = await p;
        if (socketID && connectedSockets.get(socketID)) {
            connectedSockets.get(socketID).emit('geocode-progress', { index: i, className: res.class });
        }
        return res;
    }));

    // 2.1 Create copy of returned results
    cities = promises.slice();

    // 2.2 Removed invalid addresses
    for (let i = cities.length - 1; i >= 0; i--) {
        css[i] = cities[i].class;
        coords[i] = cities[i].coords;
        if (!cities[i].address) {
            cities.splice(i, 1);
        } else {
            cities[i].originalIndex = i;
        }
    }

    let obj = await getDistFromDistAPI(cities, avoid);

    for (let i = 0; i < cities.length; i++) {
        let temp = [];
        let tempTime = [];
        let destinations = obj.rows[i].elements;
        for (let j = 0; j < destinations.length; j++) {
            if (destinations[j].status == 'OK') {
                temp.push(destinations[j].distance.value / 1600);
                tempTime.push(destinations[j].duration.value);
            } else {
                temp.push(Infinity);
                tempTime.push(Infinity);
            }
        }
        distMatrix.push(temp);
        durationMatrix.push(tempTime);
    }

    console.table(distMatrix);
    console.table(durationMatrix);

    // Check if any cities are unreachable
    let unreachable = [];
    for (let i = 0; i < distMatrix.length; i++) {
        let temp = distMatrix[i].slice()
        temp.splice(i, 1);
        if (temp.every(val => val == Infinity)) {
            unreachable.push(i)
            console.log(`${cities[i].address} is unreachable`);
        }
    }

    let paths = [];
    let bestGen = null;
    let orderedCities = [];
    const unreachableNames = unreachable.map(i => cities[i].address);
    const unreachableCoords = unreachable.map(i => cities[i].coords);
    const solveMatrix = metric === "duration" ? durationMatrix : distMatrix;
    if (unreachable.length == 0) {
        let result = await solveTSP(cities, solveMatrix, N, acc, mutationRate, socketID);
        let bestRoute = result.bestOrder;
        bestGen = result.bestGen;

        // Rotate the tour so it begins at the first valid city (index 0 in
        // the filtered cities array — the earliest-entered reachable address).
        const startPos = bestRoute.indexOf(0);
        if (startPos > 0) {
            bestRoute = bestRoute.slice(startPos).concat(bestRoute.slice(0, startPos));
        }

        console.log(bestRoute);

        orderedCities = bestRoute.map(i => ({ lat: cities[i].coords.lat, lng: cities[i].coords.lng, idx: cities[i].originalIndex }));

        // Get path for round trip
        let pathPromises = [];
        for (let i = 0; i < bestRoute.length; i++) {
            pathPromises.push(getPath(cities[bestRoute[i]], cities[bestRoute[(i + 1) % bestRoute.length]], avoid));
        }
        paths = await Promise.all(pathPromises); // Parallel calls
    }

    response.json({
        status: "OK",
        matrix: distMatrix,
        routes: paths,
        coords: coords,
        css: css,
        bestGen: bestGen,
        ordered: orderedCities,
        unreachable: unreachableNames,
        unreachableCoords: unreachableCoords,
    });
    logLine(`[cache] ${cache.diff(cacheBefore)} — external calls ${cache.externalCalls(cacheBefore)}, saved ${cache.savedCalls(cacheBefore)}`);
    logLine(`[cache] lifetime · ${cache.lifetimeReport()}`);
});

// Function to convert text addresses to coordinates
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

    const addrKey = hash(normalizeAddress(address));
    const cachedPlaceID = cache.get('geocode_addr', addrKey);
    if (cachedPlaceID) {
        const hit = cache.get('geocode', hash(cachedPlaceID));
        if (hit) {
            return hit;
        }
    }

    const url = `https://maps.googleapis.com/maps/api/geocode/json?key=${process.env.API_GEOCODE}&address=${address}`;

    try {
        const response = await axios.get(url);
        const data = response.data;

        if (data.results.length === 0) {
            return invalidObj;
        }

        const coords = data.results[0].geometry.location;
        const placeID = data.results[0].place_id;

        const result = {
            address: address,
            coords: coords,
            placeID: placeID,
            class: "ValidAddress",
        };
        cache.set('geocode_addr', addrKey, placeID);
        cache.set('geocode', hash(placeID), result);
        return result;
    } catch (error) {
        console.error('Geocoding error:', error);
        return invalidObj;
    }
}


const getDistFromDistAPI = async function (cities, avoid) {
    let origins = [];
    for (city of cities) {
        origins.push("place_id:" + city.placeID);
    }
    origins = origins.join("|");

    const key = hash(JSON.stringify({ placeIds: cities.map(c => c.placeID), avoid }));
    const hit = cache.get('matrix', key);
    if (hit) {
        return hit;
    }

    // ADD THESE LINES:
    console.log("API Key loaded:", !!process.env.API_DIST_MATRIX);
    console.log("Origins string:", origins);
    // END ADDED LINES

    const avoidParam = avoid.length > 0 ? `&avoid=${avoid.join("|")}` : "";

    return new Promise((resolve, reject) => {

        const config = {
            method: 'get',
            url: `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${origins}&units=metric${avoidParam}&key=${process.env.API_DIST_MATRIX}`,
            headers: {}
        };

        axios(config)
            .then(response => {
                console.log("Distance Matrix API Status:", response.data.status);
                if (response.data.status == 'OK') {
                    cache.set('matrix', key, response.data);
                    resolve(response.data);
                } else {
                    reject(new Error(`Distance Matrix API returned status: ${response.data.status}`));
                }
            })
            .catch(error => {
                console.log(error);
                reject();
            });
    });
}

async function solveTSP(cities, distMatrix, N, gen, mutationRate, socketID) {
    // 4. Run GA and get optimal TSP
    // Initialize order and recordDist
    let recordDist = Infinity;
    let order = [];
    let generation = 1;
    let stagnation = 0;
    let bestGen = 1;

    for (let i = 0; i < cities.length; i++) {
        order[i] = i;
    }

    let population = [];
    for (let i = 0; i < N; i++) {
        population[i] = shuffle(order).slice();
    }
    // Initialize bestOrder
    let bestOrder = order;

    order = [];
    while (generation <= gen) {
        // Implement genetic alorithm
        let { fitness, cdf } = calcFitness(population, distMatrix);
        order = population[bestOrderIndex(fitness)];

        if (calcDist(order, distMatrix) < recordDist) {
            console.log(`Found new best route`);
            stagnation = 0;
            recordDist = calcDist(order, distMatrix);
            bestOrder = order.slice();
            bestGen = generation;
            if (socketID && connectedSockets.get(socketID)) {
                connectedSockets.get(socketID).emit('route-update', {
                    coords: bestOrder.map(i => cities[i].coords),
                    recordDist: recordDist,
                });
            }
        } else {
            stagnation++;
        }

        // 2-opt local repair on the best tour: polish it each generation so
        // the route stays essentially crossing-free while the GA explores.
        twoOpt(bestOrder, distMatrix);
        const polished = calcDist(bestOrder, distMatrix);
        if (polished < recordDist) {
            console.log(`2-opt improved best route`);
            stagnation = 0;
            recordDist = polished;
            bestGen = generation;
            if (socketID && connectedSockets.get(socketID)) {
                connectedSockets.get(socketID).emit('route-update', {
                    coords: bestOrder.map(i => cities[i].coords),
                    recordDist: recordDist,
                });
            }
            population[Math.floor(Math.random() * population.length)] = bestOrder.slice();
        }

        // Champion re-injection: copy the polished best tour into a random
        // non‑elite slot so improved edges feed back into OX crossover.
        const champ = bestOrder.slice();
        if (champ.length >= 4 && !population.some(t => t.length === champ.length && t.every((v, k) => v === champ[k]))) {
            const hi = Math.max(1, population.length - 1);
            population[1 + Math.floor(Math.random() * hi)] = champ;
        }

        population = crossOver(mutationRate, population, cdf, bestOrder);

        // Yield every every so often before heavy CPU work
        if (generation % 10 === 0) {
            if (socketID && connectedSockets.get(socketID)) {
                const progress = generation / gen;
                // Diversity: count unique tours in the population
                const seen = new Set();
                for (const tour of population) seen.add(tour.join(","));
                connectedSockets.get(socketID).emit('generation-progress', {
                    progress,
                    stagnation,
                    diversity: seen.size,
                    popSize: population.length,
                });
            }
            await new Promise(resolve => setImmediate(resolve));
        }


        generation++;
    }
    console.log(`Best route unchanged for ${stagnation} generations`);
    return { bestOrder, bestGen, stagnation };
}

function calcDist(order, distMatrix) {
    let sum = 0;

    for (let i = 0; i < order.length; i++) {
        sum += distMatrix[order[i]][order[(i + 1) % order.length]];
    }
    return sum;
}

// 2-opt local repair: repeatedly reverse segments of the tour that shorten
// the round trip (triangle inequality) until no improvement remains, bounded
// to a few sweeps so it stays cheap. Mutates the tour in place.
function twoOpt(tour, distMatrix) {
    if (!tour || tour.length < 4) return;
    const n = tour.length;
    let improved = true;
    let sweeps = 0;
    while (improved && sweeps < 100) {
        improved = false;
        sweeps++;
        for (let i = 0; i < n - 1; i++) {
            const a = tour[i], b = tour[i + 1];
            for (let j = i + 2; j < n; j++) {
                const c = tour[j], d = tour[(j + 1) % n];
                if (distMatrix[a][c] + distMatrix[b][d] < distMatrix[a][b] + distMatrix[c][d] - 1e-9) {
                    let lo = i + 1, hi = j;
                    while (lo < hi) {
                        const t = tour[lo];
                        tour[lo] = tour[hi];
                        tour[hi] = t;
                        lo++;
                        hi--;
                    }
                    improved = true;
                    break;
                }
            }
            if (improved) break;
        }
    }
}

function calcFitness(population, distMatrix) {
    let fitness = [];
    for (let i = 0; i < population.length; i++) {
        let d = calcDist(population[i], distMatrix);
        let score = 1 / (1 + d);
        fitness.push(score);
    }
    let den = fitness.reduce((a, b) => a + b, 0) || 1;
    let cdf = [];
    let acc = 0;
    for (let i = 0; i < fitness.length; i++) {
        fitness[i] = fitness[i] / den;
        acc += fitness[i];
        cdf.push(acc);
    }

    return { fitness, cdf };
}

function crossOver(mutationRate, population, cdf, bestOrder) {
    let newPop = []
    const used = new Uint8Array(geneACount(population));
    for (let j = 0; j < population.length; j++) {
        used.fill(0);
        let newGenes = [];
        let a = sample(cdf);
        let b = sample(cdf);
        let geneA = population[a];
        let geneB = population[b];
        let start = Math.floor(Math.random() * geneA.length);
        let end = start + 1 + Math.floor(Math.random() * (geneA.length - start - 1));
        let subSet = geneA.slice(start, end);
        newGenes = newGenes.concat(subSet);
        for (let k = 0; k < newGenes.length; k++) used[newGenes[k]] = 1;
        for (let i = 0; i < geneB.length; i++) {
            if (!used[geneB[i]]) {
                used[geneB[i]] = 1;
                newGenes.push(geneB[i])
            }
        }
        // Mutate
        if (Math.random() < mutationRate) {
            let u = Math.floor(Math.random() * newGenes.length);
            let v = Math.floor(Math.random() * newGenes.length);
            swap(newGenes, u, v);
        }
        newPop.push(newGenes);
    }
    // Elitism: guarantee the current best survives into the next generation
    if (bestOrder && population.length > 0) {
        newPop[0] = bestOrder.slice();
    }
    return newPop;
}

function geneACount(population) {
    return population.length > 0 ? population[0].length : 0;
}

function sample(cdf) {
    let r = Math.random();
    let lo = 0, hi = cdf.length - 1;
    while (lo < hi) {
        let mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function bestOrderIndex(fitness) {
    let best = -Infinity;
    let bestIndex = 0;
    for (let i = 0; i < fitness.length; i++) {
        if (fitness[i] > best) {
            best = fitness[i];
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


function shuffle(array) {
    let currentIndex = array.length, randomIndex;

    // While there remain elements to shuffle.
    while (currentIndex != 0) {

        // Pick a remaining element.
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [
            array[randomIndex], array[currentIndex]];
    }

    return array;
}


async function getPath(cityA, cityB, avoid) {
    const key = hash(JSON.stringify({ o: cityA.placeID, d: cityB.placeID, avoid }));
    const hit = cache.get('directions', key);
    if (hit) {
        return hit;
    }

    const params = {
        origin: "place_id:" + cityA.placeID,
        destination: "place_id:" + cityB.placeID,
        travelMode: 'DRIVING',
        key: process.env.API_DIST_MATRIX,
    };
    if (avoid.length > 0) {
        params.avoid = avoid.join("|");
    }

    return new Promise((resolve, reject) => {
        client
            .directions({
                params,
                timeout: 1000, // milliseconds
            })
            .then((r) => {
                if (r.data.status === 'OK') {
                    cache.set('directions', key, r.data);
                }
                resolve(r.data);
            })
            .catch((e) => {
                console.log(e);
                reject();
            });
    })
}
