import { Scaler } from "./scaler.mjs";

export class HelicorderScaler extends Scaler {

    constructor(helicorder, unitStr, valueMin = 0, valueMax = 1, digitsToRound = 0, startPerc = 0) {
        super(unitStr, valueMin, valueMax, digitsToRound, startPerc);
        this.helicorder = helicorder;
    }

    // helicorderAttribute can be either a string for a property to
    //   change (seperated by '.'s if nested) or a setter function for the property
    setUpdates(helicorderAttribute, eventsToUpdateOn) {
        const updateFinished = this.setUpdateFunctions((val) => {
            let listeners = [];
            if (!Array.isArray(eventsToUpdateOn) && eventsToUpdateOn !== undefined) {
                eventsToUpdateOn = [eventsToUpdateOn];
            } else if (!Array.isArray(eventsToUpdateOn) || eventsToUpdateOn.length === 0) {
                eventsToUpdateOn = [];
            }
            const onEventCalled = () => {
                updateFinished();
                for (let i = 0; i < listeners.length; i++) {
                    this.helicorder.removeListener(listeners[i]);
                }
                listeners = [];
            };
            for (let i = 0; i < eventsToUpdateOn.length; i++) {
                listeners.push(this.helicorder.addListener(eventsToUpdateOn[i], () => {
                    onEventCalled();
                }));
            }
            changeAttribute(this, helicorderAttribute, val);
            if (eventsToUpdateOn.length === 0) {
                onEventCalled();
            }
        });
    }
}

// helicorderAttribute can be either a string for a property to
//   change (seperated by '.'s if nested) or a setter function for the property
function changeAttribute(hScaler, helicorderAttribute, value) {
    if (typeof helicorderAttribute === "string") {
        let attrParts = helicorderAttribute.split(".");
        let currObj = hScaler.helicorder;
        let i = 0;
        while (true) {
            if (attrParts.length == i + 1) {
                currObj[attrParts[i]] = value;
                break;
            } else {
                i++;
                try {
                    currObj = currObj[attrParts[i]];
                } catch (e) {
                    console.error(`Cannot find attribute '${helicorderAttribute}'!`);
                    return;
                }
            }
        }
    } else if (typeof helicorderAttribute === "function") {
        const callback = helicorderAttribute.bind(hScaler.helicorder);
        callback(value);
    } else {
        console.error("helicorderAttribute must be a string or a function! Got: ", helicorderAttribute);
    }
}