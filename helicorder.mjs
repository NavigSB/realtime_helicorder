
import * as seisplotjs from "./seisplotjs_3.0.0-alpha.1_standalone.mjs";
const { DateTime, Duration, Interval } = seisplotjs.luxon;


const HELI_CONFIG = {
	wheelZoom: false,
	isYAxisNice: false,
  	doGain: true,
  	centeredAmp: false,
  	fixedAmplitudeScale: [-2500, 0],
	numLines: 12
}; // Helicorder configuration - can be overridden and added to with customHeliConfig

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
		this.netCode = netCode;
        this.staCode = staCode;
        this.locCode = locCode;
        this.chanCode = chanCode;
		// Match pattern used by IRIS to identify correct data stream
		this.matchPattern = `${netCode}_${staCode}_${locCode}_${chanCode}/MSEED`;
		this.numPackets = 0;
		this.connected = false;
		this.initialized = false;
		// Setup defaults for configuration
        this.config = {
			plotTimeMax: 1440,
			url: seisplotjs.datalink.IRIS_RINGSERVER_URL,
			showNowMarker: false,
			...config
		};
		// Setup defaults for graph configuration
		this._graphConfig = {
			...HELI_CONFIG,
			title: `Helicorder for ${this.matchPattern}`,
			...(customHeliConfig ? customHeliConfig : {})
		};
		this._callbacks = {};
		this._currCallbackId = 0;
		this._callbackLock = false;
		this._drawQueue = 0;
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
			this.connected = false;
		}
	}

	// Update graph to have new given time frame
	setScale(durationMins) {
		this._graph.heliConfig.fixedTimeScale = getTimeWindow(durationMins);
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
    const timeWindow = getTimeWindow(helicorder.config.plotTimeMax);
    helicorder.timeWindow = timeWindow;

	if (!helicorder.initialized) {
		helicorder._graph = await setupGraph(helicorder, timeWindow);
	}

	// Create observer that monitors the states of the graph and fires events
	//   to the callback.
	helicorder._observer = createGraphObserver(helicorder._graph, event => {
		// Each time an event is fired, see if event type exists in _callbacks.
		//   If it does, dispatch all callbacks connected to that type.s
		if (event in helicorder._callbacks) {
			for (const index in helicorder._callbacks[event]) {
				helicorder._callbacks[event][index]();
			}
		}
	});

	if (!helicorder.initialized) {
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

	const query = new seisplotjs.fdsndataselect.DataSelectQuery();
	// Set query parameters to match the helicorder parameters
	query
		.networkCode(helicorder.netCode)
		.stationCode(helicorder.staCode)
		.locationCode(helicorder.locCode)
		.channelCode(helicorder.chanCode)
		.timeWindow(timeWindow);

	let seismograms = await query.querySeismograms();
	// Since we only have one query, the first seismogram is the only one
	const seismogram = seismograms[0];
	let seisData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		seismogram
	);
	helicorder._streamStart = seismogram.endTime;

	// create graph from returned data
	return new seisplotjs.helicorder.Helicorder(seisData, fullConfig);
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
			helicorder._graph.draw();
		}
		helicorder._drawQueue = 0;
		helicorder._callbackLock = false;
	}
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

// Returns a luxon time window from the current time to the future end point of
//   the plot, based on plotTimeScale, the amount of minutes of data to display,
//   for use in a graph object.
function getTimeWindow(plotTimeScale) {
	const plotStart = DateTime.utc()
		.endOf("hour")
		.plus({ milliseconds: 1 }); // make sure it includes whole hour
	// Keep each line's hour to an even value
	if (plotStart.hour % 2 === 1) {
		plotStart.plus({ hours: 1 });
	}
	let duration = Duration.fromDurationLike({
		minute: plotTimeScale,
	});
	
	// Time window for plot, from plotStart to plotStart + plotTimeScale
	return Interval.before(plotStart, duration);
}

// Processes packets and adds the new data to the graph.
function packetHandler(helicorder, packet) {
	// Make sure packet is miniseed for correct conversion to segment
	if (packet.isMiniseed()) {
		helicorder.numPackets++;
		let seisSegment = seisplotjs.miniseed.createSeismogramSegment(
			packet.asMiniseed()
		);

		if (helicorder._graph) {
			helicorder._graph.appendSegment(seisSegment);
		}

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
	} else {
		console.log(`not a mseed packet: ${packet.streamId}`);
	}
}