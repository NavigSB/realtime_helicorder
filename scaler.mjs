
export class Scaler {

    constructor(unitStr, valueMin = 0, valueMax = 1, digitsToRound = 0, startPerc = 0, unitsHaveSpace = true) {
        this.valueMin = valueMin;
        this.valueMax = valueMax;
        if (typeof this.valueMin !== "number" || typeof this.valueMax !== "number") {
            console.error(`Min and max values are invalid: ${valueMin}, ${valueMax}`)
        }
        this.startPerc = startPerc;
        this.digitsToRound = digitsToRound;
        if (this.startPerc < 0 || this.startPerc > 1) {
            console.error(`Start percentage provided is invalid: ${this.startPerc}`);
        }
        this.labelUnit = unitStr;
        this.unitsHaveSpace = unitsHaveSpace;
        this._onLabelUpdate = () => {};
        this._onScaleChange = () => {};
        this._updateVar = () => {};

        initScaler(this);
    }

    setUpdateFunctions(updateVarFunc) {
        // Need to know both how to change the var and when to change it
        this._updateVar = updateVarFunc;
        const doneUpdatingFunc = () => {
            this._inputEl.removeAttribute("disabled");
        };
        // Use timeout(0) to update the label on the next draw cycle
        setTimeout(() => this._updateVar(updateLabelVal(this)), 0);
        return doneUpdatingFunc;
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
    
    setLabelAttribute(attribute, value) {
        this._labelEl.setAttribute(attribute, value);
    }
    
    setInputClasses(classStr) {
        this._inputEl.classList = classStr;
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
    scaler._inputEl.value = scaler.startPerc * 100;
	let currVal = updateLabelVal(scaler);
	scaler._inputEl.oninput = () => {
		currVal = updateLabelVal(scaler);
	};
	scaler._inputEl.onchange = () => {
        scaler._inputEl.setAttribute("disabled", "disabled");
        scaler._updateVar(currVal);
        scaler._onScaleChange(currVal);
	};
}

// Updates the slider label to the given value (0-1) based on the global 
//   allowed time scale range of the helicorder. For example, if the min time
//   scale is 10 minutes and the max is 20, a value of 0.5 would update the 
//   label to indicate 15 minutes as the time scale. The function also returns
//   the calculated scale number.
function updateLabelVal(scaler) {
    let value = scaler._inputEl.value;
    const minVal = Math.min(scaler.valueMin, scaler.valueMax);
    const maxVal = Math.max(scaler.valueMin, scaler.valueMax);
    // console.log(minVal, ", ", maxVal);
    const valueRange = maxVal - minVal;
	let labelValue = (value / 100) * valueRange + minVal;
    if (scaler.digitsToRound >= 0) {
        labelValue = labelValue.toFixed(scaler.digitsToRound);
    }

	scaler._labelEl.innerText = labelValue + (scaler.unitsHaveSpace ? " " : "") + scaler.labelUnit;
    scaler._onLabelUpdate(scaler._labelEl.innerText);

	return labelValue;
}