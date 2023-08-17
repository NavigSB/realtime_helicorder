import { Helicorder } from "./helicorder.mjs"

const PLOT_TIME_MIN = 60;
const PLOT_TIME_MAX = 60 * 24;
const PLOT_TIME_START = 60;
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
    helicorder.onUpdate(() => {
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
	document.querySelector("#scale-slider").removeAttribute("disabled");

	setHeader(helicorder, helicorder.timeWindow);
	startClock();
	setupScaleSlider(helicorder);

	document.querySelector("button#pause").addEventListener("click", () => {
		paused = !paused;
		d3.select("button#pause").text(paused ? "Play" : "Pause");
        d3.select("button#disconnect").text(paused ? "Reconnect" : "Disconnect");
        if (paused) {
            helicorder.stop();
        } else {
            helicorder.start();
        }
	});

	document.querySelector("button#disconnect").addEventListener("click", () => {
        paused = !paused;
        d3.select("button#pause").text(paused ? "Play" : "Pause");
        d3.select("button#disconnect").text(paused ? "Reconnect" : "Disconnect");
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

// Sets up events to change time scale range input label upon each input change 
//   and to redraw the helicorder at the new scale when the input is released.
function setupScaleSlider(helicorder) {
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
		helicorder.setScale(currScale);
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

main();