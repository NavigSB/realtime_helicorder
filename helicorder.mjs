
import * as seisplotjs from "./seisplotjs_3.0.0-alpha.1_standalone.mjs";
const { DateTime, Duration, Interval } = seisplotjs.luxon;


const HELI_CONFIG = {
	wheelZoom: false,
	isYAxisNice: false,
  	doGain: true,
  	centeredAmp: false,
  	fixedAmplitudeScale: [-2500, 0],
	numLines: 12
}; // Helicorder configuration

export class Helicorder {

    /**
     * config: {
     *     plotTimeMax: max allowed size of plot in minutes, which is also the
     *       amount of past data loaded in an initialization (1440),
	 * 	   url: custom url for receiving data. Default is IRIS
	 * 	   showNowMarker: if true, displays a now marker on the helicorder diagram
	 *       that shows the current time, updating each packet update.
     * }
	*/
    constructor(netCode, staCode, locCode, chanCode, config, customHeliConfig) {
		this.netCode = netCode;
        this.staCode = staCode;
        this.locCode = locCode;
        this.chanCode = chanCode;
		this.matchPattern = `${netCode}_${staCode}_${locCode}_${chanCode}/MSEED`;
		this.numPackets = 0;
		this.connected = false;
		this.initialized = false;
        this.config = {
			plotTimeMax: 1440,
			url: seisplotjs.datalink.IRIS_RINGSERVER_URL,
			showNowMarker: false,
			...config
		};
		this._heliConfig = {
			...HELI_CONFIG,
			title: `Helicorder for ${this.matchPattern}`,
			...(customHeliConfig ? customHeliConfig : {})
		};
		this._oninit = () => {};
		this._onload = () => {};
		this._onupdate = () => {};
    }

	async start() {
		if (!this.initialized) {
			await initHelicorder(this);
		}

		if (!this.connected) {
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

	async stop() {
		if (this.connected) {
			this._datalink.endStream();
			this._datalink.close();

			this.connected = false;
		}
	}

	setScale(durationMins) {
		this._helicorder.heliConfig.fixedTimeScale = getTimeWindow(durationMins);
		this._helicorder.draw();
	}

	onInit(callback) {
		this._oninit = callback;
	}

	onLoad(callback) {
		this._onload = callback;
	}

	onUpdate(callback) {
		this._onupdate = callback;
	}

	addToElement(containerQuerySelector) {
		document.querySelector(containerQuerySelector).append(this._helicorder);
	}

}

async function initHelicorder(helicorderClassInst) {
    const timeWindow = getTimeWindow(helicorderClassInst.config.plotTimeMax);
    helicorderClassInst.timeWindow = timeWindow;

	const heliConfig = helicorderClassInst._heliConfig;
	helicorderClassInst._helicorder = 
		await setupHelicorder(helicorderClassInst, timeWindow, heliConfig);

	helicorderClassInst._observer = createHelicorderObserver(helicorderClassInst._helicorder, event => {
		switch(event) {
			case "initialized": helicorderClassInst._oninit(); break;
			case "loaded": helicorderClassInst._onload(); break;
			case "updated": helicorderClassInst._onupdate(); break;
		}
	});
}

function createHelicorderObserver(helicorderElement, callback) {
	const EVENTS = ["initialized", "loaded", "updated"];
	const ELEMENT_GETTERS = [
		element => element,
		element => element.shadowRoot,
		element => {
			// Get last row in helicorder to observe when updates finish
			let rows = Array.from(element.shadowRoot.querySelectorAll("sp-seismograph"));
			return rows.length ? rows.slice(-1)[0].shadowRoot : undefined
		}
	];
	const OBSERVATION_TYPES = {
		childList: true,
		subtree: true
	};

	if (!helicorderElement) {
		console.error("Given helicorderElement is undefined.");
		return;
	} 
	
	let state = 0;
	let helicorderObserver;

	if (ELEMENT_GETTERS[1](helicorderElement) == undefined) {
		state = 0;
	}else if (ELEMENT_GETTERS[2](helicorderElement) == undefined) {
		state = 1;
	} else {
		state = 2;
	}

	helicorderObserver = new MutationObserver(() => {
		callback(EVENTS[state]);
		if (state < EVENTS.length - 1) {
			state++;
			helicorderObserver.disconnect();
			helicorderObserver.observe(ELEMENT_GETTERS[state](helicorderElement), OBSERVATION_TYPES);
		}
	});
	// Observe childList to see when any elements have been added to last
	//   row, as well as subtree for any changes to descendents.
	helicorderObserver.observe(ELEMENT_GETTERS[state](helicorderElement), OBSERVATION_TYPES);

	return helicorderObserver;
}

// Queries past data based on the station configs, instantiating and placing a
//   new helicorder on the page, given the DataLinkConnection object and a
//   luxon time window for the helicorder time range.
async function setupHelicorder(helicorderClassInst, timeWindow, config) {
	// Create new config object and add given custom options to it
	let fullConfig = new seisplotjs.helicorder.HelicorderConfig(timeWindow);
	Object.assign(fullConfig, config);

	const query = new seisplotjs.fdsndataselect.DataSelectQuery();
	// Set query parameters of query to the global info about desired data
	query
		.networkCode(helicorderClassInst.netCode)
		.stationCode(helicorderClassInst.staCode)
		.locationCode(helicorderClassInst.locCode)
		.channelCode(helicorderClassInst.chanCode)
		.timeWindow(timeWindow);

	// Initiate query and pass info to createHelicorder method
	let seismograms = await query.querySeismograms();
	
	// Since we only have one query, the first seismogram is the only one
	const seismogram = seismograms[0];
	let seisData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		seismogram
	);
	helicorderClassInst._streamStart = seismogram.endTime;

	// create helicorder and add to the page
	return new seisplotjs.helicorder.Helicorder(seisData, fullConfig);
}

// Returns a luxon time window from the current time to the future end point of
//   the plot, based on plotTimeScale, the amount of minutes of data to display,
//   for use in a helicorder object.
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

// Processes packets and adds the new data to the helicorder.
function packetHandler(helicorderClassInst, packet) {
	// Make sure packet is miniseed for correct conversion to segment
	if (packet.isMiniseed()) {
		helicorderClassInst.numPackets++;
		let seisSegment = seisplotjs.miniseed.createSeismogramSegment(
			packet.asMiniseed()
		);

		if (helicorderClassInst._helicorder) {
			helicorderClassInst._helicorder.appendSegment(seisSegment);
		}

		if (helicorderClassInst.config.showNowMarker) {
			// Add a marker that indicates where "now" is on the plot
			let nowMarker = {
				markertype: "predicted",
				name: "now",
				time: DateTime.utc(),
			};
			// Remove all other markers to make sure past "now" marker doesn't
			//   stick around
			helicorderClassInst._helicorder.seisData[0].markerList = [];
			helicorderClassInst._helicorder.seisData[0].addMarker(nowMarker);
		}
	} else {
		console.log(`not a mseed packet: ${packet.streamId}`);
	}
}