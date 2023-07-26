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
//size of plot in minutes
const PLOT_TIME_SPAN = 60;

// pattern used to get data from IRIS
const matchPattern = `${NET_CODE}_${STA_CODE}_${LOC_CODE}_${CHAN_CODE}/MSEED`;
const HELI_CONFIG = {
	wheelZoom: false,
	isYAxisNice: false,
  	doGain: true,
  	centeredAmp: false,
  	fixedAmplitudeScale: [-2500, 0],
  	title: `Helicorder for ${matchPattern}`
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
let helicorder;
let streamStart;


main();

// Main method, which creates the helicorder on the html of the page and makes
//   the interface interactive.
function main() {
	const timeWindow = initTimeWindow();
	const datalink = getDataConnection();
	setupHelicorder(datalink, timeWindow);
	setupUI(datalink, timeWindow);
}

// Creates a luxon time window from the current time to the future end point of
//   the plot, based on the PLOT_TIME_SPAN variable, for use in a
//   helicorder object.
function initTimeWindow() {
	// plot start would be changeable when looking at past data
	const plotStart = DateTime.utc()	
		.endOf("hour")
		.plus({ milliseconds: 1 }); // make sure it includes whole hour
	// Keep each line's hour to an even value
	if (plotStart.hour % 2 === 1) {
		plotStart.plus({ hours: 1 });
	}
	let duration = Duration.fromDurationLike({
		minute: PLOT_TIME_SPAN,
	});

	// Time window for plot, from plotStart to plotStart + duration
	const timeWindow = Interval.before(plotStart, duration);
	
	return timeWindow;
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
			console.assert(false, error);
		});
}

// Creates a helicorder and adds it to the page, given a seismogram data array,
//   the DataLinkConnection object, and a config object for the helicorder.
function createHelicorder(seismograms, datalink, config) {
	const lastPacket = seismograms[0];
	let seisData = seisplotjs.seismogram.SeismogramDisplayData.fromSeismogram(
		lastPacket
	);
	streamStart = lastPacket.endTime;
	// create helicorder
	helicorder = new seisplotjs.helicorder.Helicorder(seisData, config);
	// add to page
	document.querySelector("div#realtime").append(helicorder);
	// draw seismogram
	helicorder.draw();
	// start live data connection
	toggleConnect(datalink);
}

// Initializes the headers, the clock, and buttons, given the
//   DataLinkConnection object and luxon time window for the header info
//   and for button interactivity.
function setupUI(datalink, timeWindow) {
	setHeader(timeWindow);
	startClock();

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

// Toggle whether given DataLinkConnection object is connected to stream or not,
//   also updating button text
function toggleConnect(datalink) {
	stopped = !stopped;
	if (stopped) {
		if (datalink) {
			datalink.endStream();
			datalink.close();
		}
		d3.select("button#disconnect").text("Reconnect");
	} else {
		if (datalink) {
			startDataStream(datalink);
		}
		d3.select("button#disconnect").text("Disconnect");
	}
}

// Connects and starts the stream for the given DataLinkConnection object
function startDataStream(datalink) {
	datalink
		.connect()
		.then((serverId) => {
			console.log(`id response: ${serverId}`);
			return datalink.match(matchPattern);
		})
		.then((response) => {
			console.log(`match response: ${response}`);
			if(numPackets > 0)
				return datalink.positionAfter(streamStart);
		})
		.catch(() => {})
		.then(() => {
			return datalink.stream();
		})
		.catch(function (error) {
			htmlLogError(error);
			console.assert(false, error);
		});
}

// Adds an error message to the html of the page
function htmlLogError(msg) {
	d3
		.select("div#debug")
		.append("p")
		.html("Error: " + msg);
}