
// Abstract class as specification for what the other statistic classes should implement.
class BufferStatistic {
    constructor() {
        
    }

    getValue() {
        throw new Error("Method 'getValue()' must be implemented.");
    }

    update(oldValue, newValue) {
        return;
    }
}

/*
    ============================== Statistic Classes ==============================
*/
export class IterativeStatistic extends BufferStatistic {
    // iterativeChangeFunction will return the change in the statistic value, given the current
    //   statistic value, the value being replaced in the array (if any), and the value being 
    //   added to the array (if any).
    constructor(iterativeChangeFunction, initialValue = 0) {
        super();
        this.changeFunc = iterativeChangeFunction;
        this.value = initialValue;
    }

    getValue() {
        return this.value;
    }

    // If either value is not defined, null will be given as a parameter to the iterativeChangeFunction
    update(oldValue, newValue) {
        oldValue = valueDefined(oldValue) ? oldValue : null;
        newValue = valueDefined(newValue) ? newValue : null;
        this.value += this.changeFunc(this.value, oldValue, newValue);
    }
}

const EXTREME_VALUES_STORED = 10;
export class ComparisonStatistic extends BufferStatistic {
    /*
        comparisonFunction: compares two values and returns a positive number if the first value has a greater
          eval than the second, a negative number if the second value has a greater eval than
          the first, and zero otherwise.
        getBufferValueFunction: should allow for one argument (index) and return that index of the buffer
          array. Make sure to return a non-number otherwise.
        getBufferLengthFunction: should return the length of the buffer.
    */
    constructor(comparisonFunction, getBufferValueFunction, getBufferLengthFunction) {
        super();
        this.compFunc = comparisonFunction;
        this.getBufferVal = getBufferValueFunction;
        this.getBufferLen = getBufferLengthFunction;
        this.extremeValsArr = [];
    }

    getValue() {
        if (this.extremeValsArr.length > 0) {
            return this.extremeValsArr[0];
        }
        return null;
    }

    update(oldValue, newValue) {
        let oldValueDefined = valueDefined(oldValue);
        let newValueDefined = valueDefined(newValue);
        // Return if no action is to be taken on the buffer
        if (!oldValueDefined && !newValueDefined) {
            return;
        }
        // Return if the buffer is empty, unless there is just a value is being added to the buffer
        if (this.getBufferLen() === 0 && !(!oldValueDefined && newValueDefined)) {
            return;
        }

        let needsRescan = updateExtremeValsArray(this.extremeValsArr, EXTREME_VALUES_STORED,
                                                 oldValue, newValue, this.compFunc);
        if (needsRescan) {
            this._scanFullArray();
        }
    }

    _scanFullArray() {
        let extremeArr = [];
        for (let i = 0; i < this.getBufferLen(); i++) {
            let value = this.getBufferVal(i);
            let evaluation = extremeArr.length > 0 ? this.compFunc(value, peekEnd(extremeArr)) : 1;
            if (extremeArr.length < EXTREME_VALUES_STORED && evaluation > 0) {
                insertValueIntoSortedArr(extremeArr, value, this.compFunc);
                if (extremeArr.length > EXTREME_VALUES_STORED) {
                    extremeArr.splice(extremeArr.length - 1, 1);
                }
            }
        }
        this.extremeValsArr = extremeArr;
    }
}

export class IndexStatistic extends BufferStatistic {
    // IndexStatistic is an extremely light wrapper to the given selectionFunc that just makes calling the function
    //   slightly nicer-looking and allows it to be nicely grouped in an array with other, more complex statistics. 
    //   The selectionFunc gets a reference to the buffer as an argument and returns the desired value from the array, 
    //   whether that be a specific value in the array, a transformed one, or otherwise. Thus, if desired, even 
    //   iterative statistics can be implemented manually through this function.
    constructor(selectionFunction) {
        super();
        this.selectionFunc = selectionFunction;
    }

    getValue() {
        return this.selectionFunc();
    }
}


/*
    ============================== Helper classes for common statistics ==============================
*/

export class MedianStatistic extends IndexStatistic {
    constructor(getBufferValueFunction, getBufferLengthFunction) {
        super(() => {
            const getVal = getBufferValueFunction;
            const length = getBufferLengthFunction();
            if (length === 0) {
                return;
            }
            let index = Math.floor((length - 0.1) / 2);
            if (length % 2 == 0) {
                return (getVal(index) + getVal(index + 1)) / 2;
            } else if (index < length) {
                return getVal(index);
            }
        });
    }
}

export class MinimumStatistic extends ComparisonStatistic {
    constructor(getBufferValueFunction, getBufferLengthFunction) {
        super((a, b) => b - a, getBufferValueFunction, getBufferLengthFunction);
    }
}

export class MaximumStatistic extends ComparisonStatistic {
    constructor(getBufferValueFunction, getBufferLengthFunction) {
        super((a, b) => a - b, getBufferValueFunction, getBufferLengthFunction);
    }
}

export class MeanStatistic extends IterativeStatistic {
    constructor(getBufferValueFunction, getBufferLengthFunction) {
        super((currMean, oldVal, newVal) => {
            let length = getBufferLengthFunction();
            if (oldVal !== null && newVal !== null) {
                // Replacing a value
                return (newVal - oldVal) / length;
            } else if (oldVal != null) {
                // Removing a value
                return (currMean - oldVal) / length;
            } else if (newVal != null) {
                // Adding a value
                return (newVal - currMean) / length;
            }
            return 0;
        });
        this.getVal = getBufferValueFunction;
    }
}


/*
    ============================== Helper methods ==============================
*/

// In compFunc, return <0 or false when the current order needs to be flipped (e.g. should be: [b, a])
function insertValueIntoSortedArr(sortedArr, value, compFunc) {
    sortedArr.push(value);
    let currIndex = sortedArr.length - 1;
    // This compFunc call is asking whether value should be ahead of the one currently ahead of it
    while (compFunc(value, sortedArr[currIndex - 1]) > 0 && currIndex >= 1) {
        sortedArr[currIndex] = sortedArr[currIndex - 1];
        sortedArr[currIndex - 1] = value;
        currIndex--;
    }
}

// A greatestEval array is an array that only stores the highest values in a series,
//   and highest here means according to a given eval function. The arguments are the
//   current greatestEval array, a value in the series being replaced, the value
//   replacing it, and a comparison function. The given array is updated according to
//   whether the values involved are/should be in the array. The comparision function
//   compares two values and returns a positive number if the first value has a greater
//   eval than the first, a negative number if the second value has a greater eval than
//   the first, and zero otherwise. If a new scan is needed, true is returned, false otherwise.
function updateExtremeValsArray(extremeArr, maxLen, oldValue, newValue, compFunc) {
    if (extremeArr.length === 0) {
        return true;
    }
    // Checks whether the value being replaced should have been in the greatestEvalArr
    //   (we check for ties also because it affects whether we know the value should 
    //   continue to be in the array)
    if (valueDefined(oldValue) && compFunc(oldValue, peekEnd(extremeArr)) >= 0) {
        let valueIndex = extremeArr.indexOf(oldValue);
        if (valueIndex < 0) {
            console.error("The old greatestEvalArr did not contain the expected value!");
        }
        extremeArr.splice(valueIndex, 1);
    }
    if (valueDefined(newValue)) {
        let haveToReplaceValue = extremeArr.length >= maxLen;
        let valueBelongsInArr = compFunc(newValue, peekEnd(extremeArr)) > 0;
        // Remove a value if we are replacing a value and the new value is eligible
        if (haveToReplaceValue && valueBelongsInArr) {
            extremeArr.splice(extremeArr.length - 1, 1);
        }
        // Add value, unless you'd have to replace a value but the given value isn't valued
        //   high enough to replace the lowest value in the array.
        if (!(haveToReplaceValue && !valueBelongsInArr)) {
            insertValueIntoSortedArr(extremeArr, newValue, compFunc);
        }
    }
    return (extremeArr.length === 0);
}

function peekEnd(array) {
    return array[array.length - 1];
}

function valueDefined(value) {
    return (value || value === 0);
}