
import * as seisplotjs from "./seisplotjs_3.1.1_standalone.mjs";
const { DateTime, Duration, Interval } = seisplotjs.luxon;
import { GraphQueueBuffer } from "./graphQueueBuffer.mjs";

const DATA_MIN = -2500;
const DATA_MAX = 0;
const HELI_CONFIG = {
	wheelZoom: false,
	isYAxisNice: false,
  	doGain: true,
  	centeredAmp: false,
	fixedAmplitudeScale: [DATA_MIN, DATA_MAX],
	numLines: 12
}; // Helicorder configuration - can be overridden and added to with customHeliConfig
// Additional amount of data (in minutes) to store internally
const EXTRA_MINS_STORED = 10;
// Minimum amount of time (in milliseconds) to request graph data
const MIN_DATA_REQ_SIZE = 60000;

export class Helicorder {

    /**
     * config (configuration object for this Helicorder class): {
     *     plotTimeMax: max allowed size of plot in minutes, which is also the
     *       amount of past data loaded in an initialization (1440),
	 * 	   url: custom url for receiving data. Default is IRIS
	 * 	   showNowMarker: if true, displays a now marker on the helicorder diagram
	 *       that shows the current time, updating each packet update.
     * },
	 * customHeliConfig - custom configuration for the graph object (seisplotjs.helicorder.Helicorder)
	*/
    constructor(netCode, staCode, locCode, chanCode, config, customHeliConfig) {
		this.DATA_MIN = DATA_MIN;
		this.DATA_MAX = DATA_MAX;
		this.netCode = netCode;
        this.staCode = staCode;
        this.locCode = locCode;
        this.chanCode = chanCode;
		// Match pattern used by IRIS to identify correct data stream
		this.matchPattern = `${netCode}_${staCode}_${locCode}_${chanCode}/MSEED`;
		this.numPackets = 0;
		this.connected = false;
		this.initialized = false;
		this.yScale = 1;
		// Setup defaults for configuration
        this.config = {
			plotTimeMax: 1440,
			url: seisplotjs.datalink.IRIS_RINGSERVER_URL,
			showNowMarker: false,
			...config
		};
		this.bufferTime = this.config.plotTimeMax + EXTRA_MINS_STORED;
		// Setup defaults for graph configuration
		this._graphConfig = {
			...HELI_CONFIG,
			title: `Helicorder for ${this.matchPattern}`,
			...(customHeliConfig ? customHeliConfig : {})
		};
		this._hasRendered = false;
		this._lastEnd;
		this._callbacks = {};
		this._currCallbackId = 0;
		this._callbackLock = false;
		this._dataTransforms = [];
		this._drawQueue = 0;
		this._hasUpdateFunc = false;
		this._segmentQueue = [];
		this._processingSegments = false;
    }

	// Connect to data source, draw graph if it hasn't been already, and
	//   set up retrieval of new data
	async start() {
		// Create connection and datalink object to request and handle new
		//   data, if not already connected
		if (!this.connected) {
			// Draw the graph and render past data. Even if we got disconnected,
			//   the graph needs to be reinitialized
			await initGraph(this);

			if (!this._datalink) {
				this._datalink = new seisplotjs.datalink.DataLinkConnection(
					this.config.url,
					(packet) => packetHandler(this, packet),
					(error) => {
						console.error(error);
					}
				);
			}

			// Connect datalink to the already-configured url
			await this._datalink.connect();
			// Link datalink to correct source with obj pattern
			await this._datalink.match(this.matchPattern);
			this._datalink.stream();
			this.connected = true;
		}
	}

	// Stop connection to data source
	async stop() {
		if (this.connected) {
			this._datalink.endStream();
			this._datalink.close();
			this._lastEnd = DateTime.utc().toSeconds();
			this.connected = false;
		}
	}

	// Add a SeismogramSegment to the helicorder
	async addSegment(segment) {
		this._segmentQueue.push(segment);
		if (this._processingSegments) {
			return;
		}
		
		this._processingSegments = true;
		for (let i = 0; i < this._segmentQueue.length; i++) {
			// Adjust internal representation of the full data forward, appending new data
			//   and removing that amount of data from the back to keep the length the same.
			this._dataBuffer.addSegment(this._segmentQueue[i]);

			let updateSegment;
			if (!this._hasUpdateFunc) {
				updateSegment = this._dataBuffer.updateGraph();
			}
			// Add new segment to graph
			if (updateSegment) {
				// let bufferMean = this._dataBuffer.getGraphMean();
				// this._graph.appendSegment(getScaledSegment(updateSegment, this.yScale, bufferMean));
				this._graph.appendSegment(getTransformedSegment(this, updateSegment));
			}
			this._segmentQueue.shift();
		}
		await patchGraphHoles(this);
		this._processingSegments = false;

		console.log(JSON.parse(JSON.stringify(this._dataBuffer.getStatistics())));
	}

	// Update graph to have new given time frame
	setTimeScale(durationMins) {
		this._graph.heliConfig.fixedTimeScale = getTimeWindow(durationMins);
		this.rerender();
	}

	getGraphUpdateFunction() {
		this._hasUpdateFunc = true;
		return (seconds) => {
			let newSegment = this._dataBuffer.updateGraphTime(seconds);
			if (newSegment) {
				// let bufferMean = this._dataBuffer.getGraphMean();
				// this._graph.appendSegment(getScaledSegment(newSegment, this.yScale, bufferMean));
				this._graph.appendSegment(getTransformedSegment(this, newSegment));
			}
		};
	}

	addDataTransform(transformFunc) {
		this._dataTransforms.push(transformFunc);
	}

	setAmpScale(scale) {
		this.yScale = scale;
		updateGraphData(this);
	}

	rerender() {
		updateGraphData(this);
		drawGraph(this);
	}

	// Adds an event listener that calls the callback when the given event occurs.
	//   Possible events: init, render, append
	//   init: Fires when the graph is first rendered
	//   render: Fires each time the graph is rendered after init
	//   append: Fires when a packet is received and the data is appended to the graph
	//   Returns the id of the listener.
	addListener(eventName, callback) {
		// _callbacks is an object with keys of event types and values of objects that map
		//   all the ids to all the callbacks for that type.
		// Initialize the event type if no callbacks have previously used it.
		if (!(eventName in this._callbacks)) {
			this._callbacks[eventName] = [];
		}
		// Map id to callback and return the id
		this._callbacks[eventName][this._currCallbackId] = callback;
		return this._currCallbackId++;
	}

	// Removes the event listener specified by its id. Returns whether deletion was successful
	removeListener(id) {
		// Go through each event type to find callback with the given id, delete it,
		//   and return.
		for (const eventType in this._callbacks) {
			if (id in this._callbacks[eventType]) {
				delete this._callbacks[eventType][id];
				return true;
			}
		}
		return false;
	}

	// Add the graph to the first element that matches the given query selector.
	addToElement(containerQuerySelector) {
		document.querySelector(containerQuerySelector).append(this._graph);
	}
}

// Creates the graph, initializes it with the past data in the current scale, and
//   initializes events for the event listeners.
async function initGraph(helicorder) {
	// Creates a time window object that is compatible with the graph object based
	//   on the plotTimeMax config value
    const timeWindow = getTimeWindow(helicorder.bufferTime);
    helicorder.timeWindow = timeWindow;

	if (!helicorder.initialized) {
		helicorder._graph = await setupGraph(helicorder, timeWindow);
		// Create observer that monitors the states of the graph and fires events
		//   to the callback.
		helicorder._observer = createGraphObserver(helicorder._graph, eventId => {
			// Each time an event is fired, see if event type exists in _callbacks.
			//   If it does, dispatch all callbacks connected to that type.
			if (eventId in helicorder._callbacks) {
				emitGraphEvent(helicorder, eventId);
			}
		});
		emitGraphEvent(helicorder, "initData");
		helicorder.initialized = true;
	}
}

// Queries past data based on the station configs and instantiates a new graph,
//   given the DataLinkConnection object and a luxon time window for the
//   graph time range.
async function setupGraph(helicorder, timeWindow) {
	// Create new config object and add custom config to it
	let fullConfig = new seisplotjs.helicorder.HelicorderConfig(timeWindow);
	Object.assign(fullConfig, helicorder._graphConfig);

	let seismogram = await getSeismogramFromTimeWindow(helicorder, timeWindow);
	helicorder._dataBuffer = new GraphQueueBuffer(seismogram, helicorder.bufferTime, () => {
		// Get graph (the actual visual start) start in millis from epoch
		return fullConfig.fixedTimeScale.start.ts;
	});
	helicorder._dataBuffer.updateGraph();
	await patchGraphHoles(helicorder);
	let displayData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		// getBufferScaledSeismogram(helicorder._dataBuffer, helicorder.yScale)
		getBufferTransformedSeismogram(helicorder)
	);

	// create graph from returned data
	return new seisplotjs.helicorder.Helicorder(displayData, fullConfig);
}

async function patchGraphHoles(helicorder) {
	let safetyMargin = 10;
	while (helicorder._dataBuffer.getFirstHole() && safetyMargin-- > 0) {
		let { startTime, endTime } = helicorder._dataBuffer.getFirstHole();
		if (endTime - startTime < MIN_DATA_REQ_SIZE) {
			let addedSize = Math.floor((MIN_DATA_REQ_SIZE - (endTime - startTime)) / 2);
			startTime -= addedSize;
			endTime += addedSize;
		}
		let startDateTime = DateTime.fromMillis(startTime, {zone: "UTC"});
		let endDateTime = DateTime.fromMillis(endTime, {zone: "UTC"});
		let holeTimeWindow = Interval.fromDateTimes(startDateTime, endDateTime);
		let holeSeismogram = await getSeismogramFromTimeWindow(helicorder, holeTimeWindow);
		if (holeSeismogram && holeSeismogram.segments.length > 0 && helicorder._dataBuffer.getFirstHole()) {
			let success = helicorder._dataBuffer.patchFirstHoleWithSeismogram(holeSeismogram);
			if (!success) {
				console.log("[WARNING] Could not patch current hole with retrieved seismogram.");
				break;
			}
		} else {
			console.log("[WARNING] Tried to patch holes when none could be filled.");
			break;
		}
	}
}

// Creates a graph observer that watches for changes in the given graphElement,
//   calling the callback with an event type string parameter whenever one happens
function createGraphObserver(graphElement, callback) {
	// Once graph is rendered for the first time, add events to
	//   graph instance functions and remove MutationObserver
	const onInit = () => {
		callback("init");
		setupObserverCallbacks(graphElement, callback);
		restartObserver.disconnect();
	};
	let restartObserver = new MutationObserver(onInit);

	// Observe childList and subtree to see when sp-seismograph
	//   elements load in, telling us the graph is rendering.
	restartObserver.observe(graphElement.shadowRoot, {
		childList: true,
		subtree: true
	});
}

// Modifies the graph to call the callback whenever an important event occurs.
function setupObserverCallbacks(graphElement, callback) {
	// Modify graph draw function to do what it did before, in addition
	//   to calling the callback with the 'render' event
	const originalDraw = graphElement.draw;
	const boundDraw = originalDraw.bind(graphElement);
	graphElement.draw = (segment) => {
		boundDraw(segment);
		callback("render");
	};

	// Modify graph appendSegment function to do what it did before, in
	//   addition to calling the callback with the 'append' event
	const originalAppend = graphElement.appendSegment;
	const boundAppend = originalAppend.bind(graphElement);
	graphElement.appendSegment = (segment) => {
		boundAppend(segment);
		callback("append");
	};
}

// Returns a luxon time window from plotTimeScale minutes before now
//   to the current time, for use in a graph object.
function getTimeWindow(plotTimeScale) {
	// Time window end is the current time
	const plotEnd = DateTime.utc()
		.endOf("hour")
		// .minus({ minutes: 20 })
		.plus({ milliseconds: 1 }); // make sure it includes whole hour
	// Keep each line's hour to an even value
	if (plotEnd.hour % 2 === 1) {
		plotEnd.plus({ hours: 1 });
	}
	let duration = Duration.fromDurationLike({
		minute: plotTimeScale,
	});
	
	// Time window for plot, from plotEnd - plotTimeScale to plotEnd
	return Interval.before(plotEnd, duration);
}

async function getSeismogramFromTimeWindow(helicorder, timeWindow) {
	const query = new seisplotjs.fdsndataselect.DataSelectQuery();
	// Set query parameters to match the helicorder parameters
	query
		.networkCode(helicorder.netCode)
		.stationCode(helicorder.staCode)
		.locationCode(helicorder.locCode)
		.channelCode(helicorder.chanCode)
		.timeRange(timeWindow);

	// Since we only have one query, the first seismogram is the only one
	return (await query.querySeismograms())[0];
}

async function updateGraphData(helicorder) {
	if (helicorder._dataBuffer.isGraphEmpty()) {
		return;
	}
	// let scaledSeismogram = getBufferScaledSeismogram(helicorder._dataBuffer, helicorder.yScale);
	let scaledSeismogram = getBufferTransformedSeismogram(helicorder);
	let displayData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		scaledSeismogram
	);
	helicorder._graph.seisData = [displayData];
	emitGraphEvent(helicorder, "render");
}

function getBufferTransformedSeismogram(helicorder) {
	// Initialize new seismogram
	let seismogram = helicorder._dataBuffer.getSeismogram();
	
	// For each segment, scale all data points and append it to the seismogram
	let segArr = [];
	for (let i = 0; i < seismogram.segments.length; i++) {
		segArr.push(getTransformedSegment(helicorder, seismogram.segments[i]));
		if (segArr[i] === undefined) {
			return;
		}
	}

	return new seisplotjs.seismogram.Seismogram(segArr);
}

function getTransformedSegment(helicorder, seismogramSegment) {
	// Use Int32Array for performace (plus it's what seisplotjs uses for segments)
	let yArr = new Int32Array(seismogramSegment.numPoints);
	for (let i = 0; i < yArr.length; i++) {
		yArr[i] = transformDataPoint(helicorder, seismogramSegment.y[i]);
		if (yArr[i] === undefined) {
			return;
		}
	}

	// Segments in seisplotjs don't allow you to directly set the y array, so
	//   we clone the old segment to get the new one instead
	return seismogramSegment.cloneWithNewData(yArr);
}

function transformDataPoint(helicorder, value) {
	let newValue = value;
	for (let i = 0; i < helicorder._dataTransforms.length; i++) {
		newValue = helicorder._dataTransforms[i](newValue, helicorder._dataBuffer.getStatistics());
		if (typeof newValue !== "number") {
			console.error("dataTransform got a value of " + newValue + "!");
			return;
		}
	}
	return newValue;
}

// Scales the given helicorder's current data to its scale, which triggers a redraw
function getBufferScaledSeismogram(dataBuffer, scale) {
	// Initialize new seismogram
	let seismogram = dataBuffer.getSeismogram();
	let mean = dataBuffer.getGraphMean();
	let emptySeg = seismogram.segments[0].cloneWithNewData([]);
	let newSeismogram = new seisplotjs.seismogram.Seismogram(emptySeg);
	
	// For each segment, scale all data points and append it to the seismogram
	for (let i = 0; i < seismogram.segments.length; i++) {
		newSeismogram.segments[0] = getScaledSegment(seismogram.segments[i], scale, mean);
	}

	return newSeismogram;
}

function getScaledSegment(seismogramSegment, scale, customMidpoint) {
	const [ DATA_MIN, DATA_MAX ] = HELI_CONFIG.fixedAmplitudeScale;
	if (!customMidpoint) {
		let minMax = seismogramSegment.findMinMax();
		customMidpoint = (minMax[1] - minMax[0]) / 2 + minMax[0];
	}

	// Use Int32Array for performace (plus it's what seisplotjs uses for segments)
	let yArr = new Int32Array(seismogramSegment.numPoints);
	for (let j = 0; j < yArr.length; j++) {
		yArr[j] = scaleDataPoint(seismogramSegment.y[j], scale, customMidpoint, DATA_MIN, DATA_MAX);
	}

	// Segments in seisplotjs don't allow you to directly set the y array, so
	//   we clone the old segment to get the new one instead
	return seismogramSegment.cloneWithNewData(yArr);
}

function scaleDataPoint(value, scale, segmentMidpoint, dataRangeMin, dataRangeMax, customDataMidpoint) {
	let dataRangeMidpoint = customDataMidpoint;
	// Calculate the current midpoint of whole data segment being scaled
	if (!customDataMidpoint) {
		dataRangeMidpoint = segmentMidpoint;
	}
	// Get amount to shift each point by to change that midpoint to the global one
	let shiftAmt = dataRangeMidpoint - scale * segmentMidpoint;

	// Scale and shift value, then clamp it to stay inside the data range
	let newVal = scale * value + shiftAmt;
	if (newVal < dataRangeMin) {
		newVal = dataRangeMin;
	}
	if (newVal > dataRangeMax) {
		newVal = dataRangeMax;
	}

	return newVal;
}

// The current events are: init, initData, render, and append
function emitGraphEvent(helicorder, eventId) {
	for (const index in helicorder._callbacks[eventId]) {
		helicorder._callbacks[eventId][index]();
	}
}

// Processes packets and adds the new data to the graph.
async function packetHandler(helicorder, packet) {
	// Make sure packet is miniseed for correct conversion to segment
	if (packet.isMiniseed()) {
		helicorder.numPackets++;
		let seisSegment = seisplotjs.miniseed.createSeismogramSegment(
			packet.asMiniseed()
		);

		if (helicorder._graph) {
			await helicorder.addSegment(seisSegment);
			
			if (helicorder.config.showNowMarker) {
				// Add a marker that indicates where "now" is on the plot
				let nowMarker = {
					markertype: "predicted",
					name: "now",
					time: DateTime.utc(),
				};
				// Remove all other markers to make sure past "now" marker doesn't
				//   stick around
				helicorder._graph.seisData[0].markerList = [];
				helicorder._graph.seisData[0].addMarker(nowMarker);
			}
		}
	} else {
		console.log(`not a mseed packet: ${packet.streamId}`);
	}
}

// Tells the graph to draw itself if the graph is not already drawing. If it
//   is, the next call to drawGraph will draw twice. This prevents any async
//   calls to try and draw the graph simulataneously.
function drawGraph(helicorder) {
	// Add one count to the amount of times to draw.
	helicorder._drawQueue++;
	// If someone else already has the lock, exit
	if (!helicorder._callbackLock) {
		helicorder._callbackLock = true;
		// Draw all the requests for draw since the last call.
		for (let i = 0; i < helicorder._drawQueue; i++) {
			// updateScaleForGraphDraw(helicorder);
			helicorder._graph.draw();
		}
		helicorder._drawQueue = 0;
		helicorder._callbackLock = false;
	}
}