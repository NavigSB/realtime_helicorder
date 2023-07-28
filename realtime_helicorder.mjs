/**
 * First attempt at recreating the helicorders on pnsn.org as a "realtime" display with scaling
 */
import * as seisplotjs from "./seisplotjs_3.0.0-alpha.1_standalone.mjs";
const { DateTime, Duration, Interval } = seisplotjs.luxon;
const d3 = seisplotjs.d3;

/*
 * Station configs
 */
const NET_CODE = "UW";
const STA_CODE = "JCW";
const LOC_CODE = "";
const CHAN_CODE = "EHZ";
// IRIS data ringserver, replace with PNSN eventually
const DATA_LINK_URL = seisplotjs.datalink.IRIS_RINGSERVER_URL;
// define range size of plot in mins
const PLOT_TIME_MIN = 60;
const PLOT_TIME_MAX = 60 * 24;
const PLOT_TIME_START = 60;

// pattern used to get data from IRIS
const matchPattern = `${NET_CODE}_${STA_CODE}_${LOC_CODE}_${CHAN_CODE}/MSEED`;
const HELI_CONFIG = {
	wheelZoom: false,
	isYAxisNice: false,
  	doGain: true,
  	centeredAmp: false,
  	fixedAmplitudeScale: [-2500, 0],
  	title: `Helicorder for ${matchPattern}`,
	numLines: 12
}; // Helicorder configuration
const LUX_CONFIG = {
	suppressMilliseconds: true,
	suppressSeconds: true
}; // Luxon Config for display

/**
 * Helicorder Set Up
 */
let numPackets = 0;
let paused = false;
let stopped = true;
let rendered = false;
let helicorder;
let streamStart;


main();

// Main method, which creates the entire helicorder on the page and 
//   interactive interface.
function main() {
	const timeWindow = getTimeWindow(PLOT_TIME_MAX);
	const datalink = getDataConnection();
	setupHelicorder(datalink, timeWindow);
	setupUI(datalink, timeWindow);
}

// Returns a new DataLinkConnection to the DATA_LINK_URL, configuring 
//   packets to go to the packetHandler function and all errors to the 
//   console & page.
function getDataConnection() {
	return new seisplotjs.datalink.DataLinkConnection(
		DATA_LINK_URL,
		packetHandler,
		(error) => {
			console.assert(false, error);
			d3.select("p#error").text("Error: " + error);
		}
	);
}

// Processes packets and adds the new data to the helicorder.
function packetHandler(packet) {
	// Make sure packet is miniseed for correct conversion to segment
	if (packet.isMiniseed()) {
		numPackets++;
		d3.select("span#numPackets").text(numPackets);
		let seisSegment = seisplotjs.miniseed.createSeismogramSegment(
			packet.asMiniseed()
		);

		if (helicorder) {
			helicorder.appendSegment(seisSegment);
		}

		// Add a marker that indicates where "now" is on the plot
		let nowMarker = {
			markertype: "predicted",
			name: "now",
			time: DateTime.utc(),
		};
		// Remove all other markers to make sure past "now" marker doesn't
		//   stick around
		helicorder.seisData[0].markerList = [];
		helicorder.seisData[0].addMarker(nowMarker);
	} else {
		console.log(`not a mseed packet: ${packet.streamId}`);
	}
}

// Queries past data based on the station configs, instantiating and placing a
//   new helicorder on the page, given the DataLinkConnection object and a
//   luxon time window for the helicorder time range.
function setupHelicorder(datalink, timeWindow) {
	// Create new config object and add global custom options to it
	let fullConfig = new seisplotjs.helicorder.HelicorderConfig(timeWindow);
	Object.assign(fullConfig, HELI_CONFIG);
	
	const query = new seisplotjs.fdsndataselect.DataSelectQuery();
	// Set query parameters of query to the global info about desired data
	query
		.networkCode(NET_CODE)
		.stationCode(STA_CODE)
		.locationCode(LOC_CODE)
		.channelCode(CHAN_CODE)
		.timeWindow(timeWindow);
	// Initiate query and pass info to createHelicorder method
	query
		.querySeismograms()
		.then(seismograms => createHelicorder(seismograms, datalink, fullConfig))
		.catch(function (error) {
			console.error(error);
		});
}

// Creates a helicorder and adds it to the page, given a seismogram data array
//   from past data, the DataLinkConnection object, and a config object for the
//   helicorder.
async function createHelicorder(seismograms, datalink, config) {
	// Since we only have one query, the first seismogram is the only one
	const seismogram = seismograms[0];
	let seisData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		seismogram
	);
	streamStart = seismogram.endTime;

	// create helicorder and add to the page
	helicorder = new seisplotjs.helicorder.Helicorder(seisData, config);
	document.querySelector("div#realtime").append(helicorder);

	// Wait for the current helicorder drawing to finish
	await waitUntilHelicorderIsStatic();
	rendered = true;

	// now redraw the helicorder at the proper global starting time scale
	updateHelicorderScale(PLOT_TIME_START);

	// start live data connection and enable interface
	await toggleConnect(datalink);
	document.querySelector("#realtime-placeholder").style.visibility = "hidden";
	document.querySelector("#realtime").style.visibility = "visible";
	document.querySelector("#scale-slider").removeAttribute("disabled");
}

// Initializes headers, the clock, and inputs, given the
//   DataLinkConnection object and helicorder's luxon time window in order to
//   set the header info and enable button interactivity.
function setupUI(datalink, timeWindow) {
	setHeader(timeWindow);
	startClock();
	setupScaleSlider();

	d3.select("button#pause").on("click", function (d) {
		paused = !paused;
		d3.select("button#pause").text(paused ? "Play" : "Pause");
	});

	d3.select("button#disconnect").on("click", function (d) {
		toggleConnect(datalink);
	});
}

// Set the time frame, current time, and site info titles based on global
//   variables and the luxon time window for the helicorder.
function setHeader(timeWindow) {
	document.querySelector("span#starttime").textContent = timeWindow.start.toISO(LUX_CONFIG);
	document.querySelector("span#endtime").textContent = timeWindow.end.toISO(LUX_CONFIG);
	d3
		.select("span#channel")
		.text(`${NET_CODE}.${STA_CODE}.${LOC_CODE}.${CHAN_CODE}`);
}

// Begin interval of updating current time title each second.
function startClock() {
	const currentTimeDiv = document.querySelector("span#currentTime");
	setInterval(() => {
		currentTimeDiv.textContent = DateTime.utc();
	}, 1000);
}

// Sets up events to change time scale range input label upon each input change 
//   and to redraw the helicorder at the new scale when the input is released.
function setupScaleSlider() {
	const scaleInput = document.querySelector("#scale-slider");
	// Initialize scaleInput at PLOT_TIME_START by mapping it onto a scale from
	//   zero to one
	scaleInput.value = (PLOT_TIME_START - PLOT_TIME_MIN) / (PLOT_TIME_MAX - PLOT_TIME_MIN);
	if (scaleInput.value < 0 || scaleInput.value > 1) {
		console.error("Scale range configuration is invalid!");
		return;
	}

	// When the range input moves at all, the oninput event sets the currScale
	//   variable, and then the moment that the input sets a new value
	//   (on release), the helicorder is redrawn at the new scale.
	let currScale = updateScaleLabel(scaleInput.value);
	scaleInput.oninput = () => {
		currScale = updateScaleLabel(scaleInput.value)
	};
	scaleInput.onchange = () => {
		updateHelicorderScale(currScale);
	};
}

// Updates the slider label to the given value (0-1) based on the global 
//   allowed time scale range of the helicorder. For example, if the min time
//   scale is 10 minutes and the max is 20, a value of 0.5 would update the 
//   label to indicate 15 minutes as the time scale. The function also returns
//   the calculated scale number.
function updateScaleLabel(value) {
	const scaleLabel = document.querySelector("#scale-val");
	// Only set first word of label so that the units label or other parts
	//   can be customized in the HTML
	let labelParts = scaleLabel.innerText.split(" ");
	let labelValue = Math.round((value / 100)
						* (PLOT_TIME_MAX - PLOT_TIME_MIN) + PLOT_TIME_MIN);
	labelParts[0] = labelValue;
	scaleLabel.innerText = labelParts.join(" ");

	return labelValue;
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

// Returns a promise that resolves once the helicorder has finished
//   updating/drawing.
function waitUntilHelicorderIsStatic() {
	return new Promise(resolve => {
		// Create MutationObserver to subscribe to changes in helicorder HTML
		const helicorderObserver = new MutationObserver(() => {
			// When any change is detected, resolve. This works because
			//   mutations in the helicorder are done sequentially, so once the
			//   element is done mutating, only then are mutation events sent
			//   to this callback.
			helicorderObserver.disconnect();
			resolve();
		});
		// Subscribe to changes in the last helicorder row so that once
		//   mutations have finished on the last row, all rows are done.
		const wrapperElement = Array.from(document.querySelector("sp-helicorder").shadowRoot
			.querySelectorAll("sp-seismograph"))
			.slice(-1)[0].shadowRoot;
		// Observe childList to see when any elements have been added to last
		//   row, as well as subtree for any changes to descendents.
		helicorderObserver.observe(wrapperElement, {
			childList: true,
			subtree: true
		});
	});
}

// Redraws the helicorder at the given scale (in minutes) and deactivates the 
//   scale range input until the drawing finishes.
async function updateHelicorderScale(scale) {
	// Ensure updates only happen one at a time, for added robustness
	if(rendered) {
		rendered = false;
		document.querySelector("#scale-slider").setAttribute("disabled", "");
		
		// Reset time scale as new luxon time window, redraw helicorder, and
		//   wait for updates to finish.
		helicorder.heliConfig.fixedTimeScale = getTimeWindow(scale);
		helicorder.draw();
		await waitUntilHelicorderIsStatic();
		
		rendered = true;
		document.querySelector("#scale-slider").removeAttribute("disabled");
	}
}

// Toggle whether given DataLinkConnection object is connected to stream or not,
//   also updating associated button text
async function toggleConnect(datalink) {
	stopped = !stopped;
	if (datalink) {
		// If newly disconnected, remove current connections. Otherwise, 
		//   re-establish connection.
		if (stopped) {
			datalink.endStream();
			datalink.close();
		} else {
			await startDataStream(datalink);
		}
	}
	d3.select("button#disconnect").text(stopped ? "Reconnect" : "Disconnect");
}

// Connects and starts the stream for the given DataLinkConnection object
async function startDataStream(datalink) {
	// Connect datalink to the already-configured url
	let serverId = await datalink.connect();
	console.log(`id response: ${serverId}`);

	// Link datalink to correct source with global pattern
	let response = await datalink.match(matchPattern);
	console.log(`match response: ${response}`);

	// If packets already received from source, adjust datalink position to 
	//   current data
	if(numPackets > 0) {
		return datalink.positionAfter(streamStart);
	}

	datalink.stream();
}