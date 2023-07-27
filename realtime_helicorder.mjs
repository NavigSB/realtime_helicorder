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

// Main method, which creates the helicorder on the html of the page and makes
//   the interface interactive.
function main() {
	const timeWindow = getTimeWindow(PLOT_TIME_MAX);
	const datalink = getDataConnection();
	setupHelicorder(datalink, timeWindow);
	setupUI(datalink, timeWindow);
}

// Creates a DataLinkConnection to the DATA_LINK_URL, sending all packets to
//   the packetHandler function and prints errors to the console and page.
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

// Processes packets and adds the new data to the helicorder
function packetHandler(packet) {
	if (packet.isMiniseed()) {
		numPackets++;
		d3.select("span#numPackets").text(numPackets);
		let seisSegment = seisplotjs.miniseed.createSeismogramSegment(
			packet.asMiniseed()
		);

		if (helicorder) {
			helicorder.appendSegment(seisSegment);
		}

		let nowMarker = {
			markertype: "predicted",
			name: "now",
			time: DateTime.utc(),
		};
		// Marker that indicates the current time should move along instead of redraw
		helicorder.seisData[0].markerList = [];
		helicorder.seisData[0].addMarker(nowMarker);
	} else {
		console.log(`not a mseed packet: ${packet.streamId}`);
	}
}

// Queries past data based on the station configs, placing a new helicorder
//   on the page, given the DataLinkConnection object and a luxon time window
function setupHelicorder(datalink, timeWindow) {
	let fullConfig = new seisplotjs.helicorder.HelicorderConfig(timeWindow);
	Object.assign(fullConfig, HELI_CONFIG);
	
	const query = new seisplotjs.fdsndataselect.DataSelectQuery();
	query
		.networkCode(NET_CODE)
		.stationCode(STA_CODE)
		.locationCode(LOC_CODE)
		.channelCode(CHAN_CODE)
		.timeWindow(timeWindow);
	query
		.querySeismograms()
		.then(seismograms => createHelicorder(seismograms, datalink, fullConfig))
		.catch(function (error) {
			console.error(error);
		});
}

// Creates a helicorder and adds it to the page, given a seismogram data array,
//   the DataLinkConnection object, and a config object for the helicorder.
async function createHelicorder(seismograms, datalink, config) {
	const lastPacket = seismograms[0];
	let seisData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		lastPacket
	);
	streamStart = lastPacket.endTime;
	// create helicorder
	helicorder = new seisplotjs.helicorder.Helicorder(seisData, config);
	// add to page
	document.querySelector("div#realtime").append(helicorder);
	await waitUntilHelicorderIsStatic();
	rendered = true;
	// draw seismogram
	updateHelicorderScale(PLOT_TIME_START);
	// start live data connection
	await toggleConnect(datalink);
	document.querySelector("#realtime-placeholder").style.visibility = "hidden";
	document.querySelector("#realtime").style.visibility = "visible";
	document.querySelector("#scale-slider").removeAttribute("disabled");
}

// Initializes the headers, the clock, and buttons, given the
//   DataLinkConnection object and luxon time window for the header info
//   and for button interactivity.
function setupUI(datalink, timeWindow) {
	setHeader(timeWindow);
	startClock();
	setupScaleSlider();

	d3.select("button#pause").on("click", function (d) {
		paused = !paused;
		if (paused) {
			d3.select("button#pause").text("Play");
		} else {
			d3.select("button#pause").text("Pause");
		}
	});

	d3.select("button#disconnect").on("click", function (d) {
		toggleConnect(datalink);
	});
}

// Set the time frame, current time, and site info titles based on global
//   variables and the luxon time window for the helicorder.
function setHeader(timeWindow) {
	document.querySelector("span#starttime").textContent =
		timeWindow.start.toISO(LUX_CONFIG);
	document.querySelector("span#endtime").textContent =
		timeWindow.end.toISO(LUX_CONFIG);
	d3
		.select("span#channel")
		.text(`${NET_CODE}.${STA_CODE}.${LOC_CODE}.${CHAN_CODE}`);
}

// Begin interval of updating current time title each second
function startClock() {
	const currentTimeDiv = document.querySelector("span#currentTime");
	setInterval(() => {
		currentTimeDiv.textContent = DateTime.utc();
	}, 1000);
}

// Changes slider label on each change and redraws the helicorder when
//   the input is released
function setupScaleSlider() {
	const scaleInput = document.querySelector("#scale-slider");
	scaleInput.value = (PLOT_TIME_START - PLOT_TIME_MIN) / (PLOT_TIME_MAX - PLOT_TIME_MIN);
	if (scaleInput.value < 0 || scaleInput.value > 1) {
		console.error("Scale range configuration is invalid!");
	}
	let currScale = updateScaleLabel(scaleInput.value);

	scaleInput.oninput = () => {
		currScale = updateScaleLabel(scaleInput.value)
	};
	scaleInput.onchange = () => {
		updateHelicorderScale(currScale);
	};
}

function updateScaleLabel(value) {
	const scaleLabel = document.querySelector("#scale-val");
	let labelParts = scaleLabel.innerText.split(" ");
	let labelValue = Math.round((value / 100) 
						* (PLOT_TIME_MAX - PLOT_TIME_MIN) + PLOT_TIME_MIN);
	labelParts[0] = labelValue;
	scaleLabel.innerText = labelParts.join(" ");
	return labelValue;
}

async function updateHelicorderScale(scale) {
	if(rendered) {
		rendered = false;
		document.querySelector("#scale-slider").setAttribute("disabled", "");

		helicorder.heliConfig.fixedTimeScale = getTimeWindow(scale);
		helicorder.draw();
		await waitUntilHelicorderIsStatic();

		rendered = true;
		document.querySelector("#scale-slider").removeAttribute("disabled");
	}
}

function waitUntilHelicorderIsStatic() {
	return new Promise(resolve => {
		const helicorderObserver = new MutationObserver(() => {
			helicorderObserver.disconnect();
-			resolve();
		});
		const wrapperElement = Array.from(document.querySelector("sp-helicorder").shadowRoot
			.querySelectorAll("sp-seismograph"))
			.slice(-1)[0].shadowRoot;
		helicorderObserver.observe(wrapperElement, {
			childList: true,
			subtree: true
		});
	});
}

// Creates a luxon time window from the current time to the future end point of
//   the plot, based on plotTimeScale, the amount of minutes of data to display,
//   for use in a helicorder object.
function getTimeWindow(plotTimeScale) {
	// plot start would be changeable when looking at past data
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

	// Time window for plot, from plotStart to plotStart + duration
	return Interval.before(plotStart, duration);
}

// Toggle whether given DataLinkConnection object is connected to stream or not,
//   also updating button text
async function toggleConnect(datalink) {
	stopped = !stopped;
	if (stopped) {
		if (datalink) {
			datalink.endStream();
			datalink.close();
		}
		d3.select("button#disconnect").text("Reconnect");
	} else {
		d3.select("button#disconnect").text("Disconnect");
		if (datalink) {
			await startDataStream(datalink)
		}
	}
}

// Connects and starts the stream for the given DataLinkConnection object
async function startDataStream(datalink) {
	try {
		let serverId = await datalink.connect();
		console.log(`id response: ${serverId}`);

		let response = await datalink.match(matchPattern);
		console.log(`match response: ${response}`);

		if(numPackets > 0)
			return datalink.positionAfter(streamStart);
	} catch (error) {
		htmlLogError(error);
		console.error(error);
	}
	return datalink.stream();
}

// Adds an error message to the html of the page
function htmlLogError(msg) {
	d3
		.select("div#debug")
		.append("p")
		.html("Error: " + msg);
}