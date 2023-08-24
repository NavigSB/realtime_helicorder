import { Helicorder } from "./helicorder.mjs"
import { HelicorderScaler } from "./hscaler_plugin.mjs";

const PLOT_TIME_MIN = 60;
const PLOT_TIME_MAX = 60 * 24;
const LUX_CONFIG = {
    suppressMilliseconds: true,
	suppressSeconds: true
}; // Luxon Config for display

let helicorder;
let fullyLoaded = false;
let paused = false;

async function main() {
    helicorder = new Helicorder("UW", "JCW", "", "EHZ", {
        showNowMarker: true
    });
    helicorder.addListener("init", () => {
        if (!fullyLoaded) {
            setupUI(helicorder);
            fullyLoaded = true;
        }
    });
    await helicorder.start();
    helicorder.addToElement("#realtime");   
}

// Initializes headers, the clock, and inputs, given the
//   DataLinkConnection object and helicorder's luxon time window in order to
//   set the header info and enable button interactivity.
function setupUI(helicorder) {
    document.querySelector("#realtime-placeholder").style.visibility = "hidden";
	document.querySelector("#realtime").style.visibility = "visible";

	setHeader(helicorder, helicorder.timeWindow);
	startClock();

	const hScaler = new HelicorderScaler(helicorder, PLOT_TIME_MIN, PLOT_TIME_MAX, 0);
	hScaler.addInputToElement("#scale-slider-container");
	hScaler.addLabelToElement("#scale-slider-container");

	document.querySelector("button#pause").addEventListener("click", () => {
		paused = !paused;
		document.querySelector("button#pause").innerHTML = paused ? "Play" : "Pause";
        if (paused) {
            helicorder.stop();
        } else {
            helicorder.start();
        }
	});
}

// Set the time frame, current time, and site info titles based on global
//   variables and the luxon time window for the helicorder.
function setHeader(helicorder, timeWindow) {
	document.querySelector("span#starttime").textContent = timeWindow.start.toISO(LUX_CONFIG);
	document.querySelector("span#endtime").textContent = timeWindow.end.toISO(LUX_CONFIG);
	document.querySelector("span#channel").textContent = helicorder.matchPattern;
}

// Begin interval of updating current time title each second.
function startClock() {
	const currentTimeDiv = document.querySelector("span#currentTime");
	setInterval(() => {
		currentTimeDiv.textContent = new Date().toISOString();
	}, 1000);
}

main();