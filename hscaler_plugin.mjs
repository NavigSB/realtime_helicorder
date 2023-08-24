
export class HelicorderScaler {

    constructor(helicorder, timeScaleMin = 60, timeScaleMax = 1440, startPerc = 0) {
        this.helicorder = helicorder;
        this.timeScaleMin = timeScaleMin;
        if (this.timeScaleMin < 0 || this.timeScaleMax < 0 || this.timeScaleMax - this.timeScaleMin < 0) {
            console.error(`Time scale provided is invalid: ${this.timeScaleMin}, ${this.timeScaleMax}`);
        }
        this.timeScaleMax = timeScaleMax;
        this.startPerc = startPerc;
        if (this.startPerc < 0 || this.startPerc > 1) {
            console.error(`Start percentage provided is invalid: ${this.startPerc}`);
        }
        this.labelUnit = "mins";
        this._onLabelUpdate = () => {};
        this._onScaleChange = () => {};

        initScaler(this);
    }

    changeLabelUnit(unitStr) {
        this.labelUnit = unitStr;
    }

    onLabelUpdate(callback) {
        this._onLabelUpdate = callback;
    }

    onScaleChange(callback) {
        this._onScaleChange = callback;
    }

    setInputAttribute(attribute, value) {
        this._inputEl.setAttribute(attribute, value);
    }

    setInputClasses(classStr) {
        this._inputEl.classList = classStr;
    }

    setLabelAttribute(attribute, value) {
        this._labelEl.setAttribute(attribute, value);
    }

    setLabelClasses(classStr) {
        this._labelEl.classList = classStr;
    }

    addInputToElement(containerQuerySelector) {
        document.querySelector(containerQuerySelector).append(this._inputEl);
    }
    
    addLabelToElement(containerQuerySelector) {
        document.querySelector(containerQuerySelector).append(this._labelEl);
    }
}

// Sets up events to change time scale range input label upon each input change 
//   and to redraw the helicorder at the new scale when the input is released.
function initScaler(scaler) {
    scaler._inputEl = document.createElement("input");
    scaler._inputEl.type = "range";
    scaler._inputEl.value = scaler.startPerc;

    scaler._labelEl = document.createElement("span");

	// When the range input moves at all, the oninput event sets the currScale
	//   variable, and then the moment that the input sets a new value
	//   (on release), the helicorder is redrawn at the new scale.
	let currScale = updateScaleLabel(scaler);
	scaler.helicorder.setScale(currScale);
	scaler._inputEl.oninput = () => {
		currScale = updateScaleLabel(scaler);
	};
	scaler._inputEl.onchange = () => {
        let initListener, renderListener;
        const changeCallback = () => {
            scaler._inputEl.removeAttribute("disabled");
            scaler.helicorder.removeListener(initListener);
            scaler.helicorder.removeListener(renderListener);
        };
        initListener = scaler.helicorder.addListener("render", changeCallback);
        renderListener = scaler.helicorder.addListener("render", changeCallback);
        scaler._inputEl.setAttribute("disabled", "disabled");
        scaler.helicorder.setScale(currScale);
        scaler._onScaleChange(currScale);
	};
}

// Updates the slider label to the given value (0-1) based on the global 
//   allowed time scale range of the helicorder. For example, if the min time
//   scale is 10 minutes and the max is 20, a value of 0.5 would update the 
//   label to indicate 15 minutes as the time scale. The function also returns
//   the calculated scale number.
function updateScaleLabel(scaler) {
    let value = scaler._inputEl.value;
    const timeScaleRange = scaler.timeScaleMax - scaler.timeScaleMin;
    const timeScaleInitial = scaler.startPerc * timeScaleRange + scaler.timeScaleMin;
	let labelValue = Math.round((value / 100) * timeScaleRange + timeScaleInitial);

	scaler._labelEl.innerText = labelValue + " " + scaler.labelUnit;
    scaler._onLabelUpdate(scaler._labelEl.innerText);

	return labelValue;
}