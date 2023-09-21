import * as seisplotjs from "./seisplotjs_3.0.0-alpha.1_standalone.mjs";


const BufferArrayClass = Int32Array;

export class GraphQueueBuffer {

    constructor(seismogram, plotMins) {
        this.bufferLen = Math.floor(60 * plotMins * seismogram.sampleRate);
        this.sampleRate = seismogram.sampleRate;
        this.startTime = seismogram.startTime.toMillis();
        this._millisPerSample = 1000 / this.sampleRate;
        this._dataArr = new BufferArrayClass(this.bufferLen);
        this._dataArr.fill(-2500);
        this._bufferStartIndex = 0;
        this._partitionIndex = 0;
        this._graphLen = 0;
        this._queueLen = 0;
        this._mean = 0;
        this._holesArr = [];
        this._segmentTemplate = seismogram.segments[0].cloneWithNewData([]);
        for (let i = 0; i < seismogram.segments.length; i++) {
            this.addSegment(seismogram.segments[i]);
        }
    }

    addSegment(seismogramSegment) {
        let segmentData = getDataFromSeismogramSegment(seismogramSegment, this);
        if (!segmentData) {
            return false;
        }
        let { _dataArr, startIndex } = segmentData;
        let offsetIndex = startIndex - (this._graphLen + this._queueLen);
        if (offsetIndex < 0) {
            console.log("[WARNING] Cannot add a segment before last inserted data! " +
                          "If trying to patch a hole, please use patchFirstHole()");
            return false;
        }

        if (offsetIndex > 0) {
            // Hole start and end indices are both inclusive
            this._holesArr.push([
                this._graphLen + this._queueLen,
                this._graphLen + this._queueLen + offsetIndex - 1
            ]);
            let last = this._holesArr.length - 1;
            if (last > 0 && this._holesArr[last - 1][1] > this._holesArr[last][0]) {
                console.error("New hole is not further in time than past holes!");
                return false;
            }
        }

        return this.addData(_dataArr, offsetIndex);
    }

    _printLengths() {
        console.log("this._graphLen + this._queueLen = " + (this._graphLen + this._queueLen));
        console.trace();
    }

    addData(data, offsetIndex = 0) {
        if (!data) {
            console.log("[WARNING] addData is being called without any input!");
            return false;
        }
        if (data.length === undefined) {
            data = [data];
        }

        let queueSpacesLeft = this.bufferLen - (this._graphLen + this._queueLen + offsetIndex);
        
        let staticData = [];
        let cycleData = [];
        if (queueSpacesLeft <= 0) {
            cycleData = data.slice();
        } else {
            staticData = data.slice(0, queueSpacesLeft);
            cycleData = data.slice(queueSpacesLeft);
        }
        this._addDataWhileNotFull(staticData, offsetIndex);
        this._addDataWhileFull(cycleData, offsetIndex);
        return true;
    }

    _addDataWhileNotFull(data, offsetIndex) {
        // Return mean variable to only be the sum of values
        this._mean *= this._graphLen + this._queueLen;
        this._queueLen += data.length > 0 ? offsetIndex : 0;
        for (let i = 0; i < data.length; i++) {
            this.bufferSet(this._partitionIndex + this._queueLen, data[i]);
            this._mean += data[i];
            this._queueLen++;
        }
        // Divide mean by new amount of data
        this._mean /= this._graphLen + this._queueLen;
    }

    _addDataWhileFull(data, offsetIndex) {
        let repetitions = data.length > 0 ? data.length + offsetIndex : 0;
        for (let i = 0; i < repetitions; i++) {
            if (this._partitionIndex > 0) {
                this._partitionIndex--;
                this._graphLen--;
                this._queueLen++;
            }
            this.shiftLeft();
            if (i >= offsetIndex) {
                // Total values don't change, so divide the change in mean by total length
                //   to get the overall mean change
                let meanSumChange = data[i] - this.bufferGet(this.bufferLen - 1);
                this._mean += meanSumChange / (this._graphLen + this._queueLen);
                this.bufferSet(this.bufferLen - 1, data[i]);
            }
        }
    }

    updateGraphTime(updateSeconds) {
        let numValues;
        if (updateSeconds) {
            numValues = Math.floor(1000 * updateSeconds / this._millisPerSample);
        }
        return this.updateGraph(numValues);
    }

    updateGraph(numValues) {
        if (numValues === undefined) {
            numValues = this._queueLen;
        }
        // Limit values in graph to be before the first hole if applicable
        if (this._holesArr.length > 0 && this._partitionIndex + numValues > this._holesArr[0][0]) {
            numValues = this._holesArr[0][0] - this._partitionIndex;
        }

        this._partitionIndex += numValues;
        this._queueLen -= numValues;
        if (this._partitionIndex >= this.bufferLen) {
            this._partitionIndex = this.bufferLen;
        }
        if (this._queueLen < 0) {
            this._queueLen = 0;
        }
        this.updateGraphLength(numValues);
    
        let newValuesStartIndex = this._graphLen - numValues;
        if (numValues > 0) {
            let dataAddedArr = 
                this.bufferSlice(newValuesStartIndex, newValuesStartIndex + numValues);
            return this.getSegment(dataAddedArr, newValuesStartIndex);
        }
        return false;
    }

    updateGraphLength(numValues) {
        let currIndex = this._partitionIndex - 1;
        let foundDefinedVal = false;
        for (let i = 0; i < numValues; i++) {
            if (this.bufferGet(currIndex) !== undefined) {
                foundDefinedVal = true;
                break;
            }
            currIndex--;
        }
        if (foundDefinedVal) {
            // Set to the last defined value in graph +1 for the curr length of the graph
            this._graphLen = currIndex + 1;
        }
    }

    // Returns an object with these keys:
    //  startTime: time of the start of the hole in milliseconds from the epoch
    //  endTime: time of the end of the hole in milliseconds from the epoch
    getFirstHole() {
        if (this._holesArr.length === 0) {
            return;
        }
        let [ startIndex, endIndex ] = this._holesArr[0];
        return {
            startTime: startIndex * this._millisPerSample + this.startTime,
            endTime: endIndex * this._millisPerSample + this.startTime
        };
    }

    patchFirstHoleWithSeismogram(seismogram) {
        let dataArr = [];
        let foundAnyData = false;
        let startIndices = [];
        if (!seismogram.segments) {
            return false;
        }
        for (let i = 0; i < seismogram.segments.length; i++) {
            let segmentData = getDataFromSeismogramSegment(seismogram.segments[i], this);
            if (segmentData) {
                let { _dataArr: segDataArr, startIndex: segStartIndex } = segmentData;
                dataArr.push(segDataArr);
                startIndices.push(segStartIndex);
                foundAnyData = true;
            }
        }
        if (!foundAnyData) {
            return false;
        }
        return this.patchFirstHole(dataArr, startIndices);
    }

    // segmentDataArr is an array of arrays, with each inner array being one segment's data
    // segmentStartIndices is an array of integers, each one corresponding to the starting 
    //   index of the parallel segment data
    patchFirstHole(segmentDataArr, segmentStartIndices) {
        if (!segmentDataArr || segmentDataArr.length === undefined) {
            return false;
        }
        const [ holeStart, holeEnd ] = this._holesArr[0];
        if (!isHoleDataValid(this, segmentDataArr, segmentStartIndices, holeStart, holeEnd)) {
            return false;
        }
        for (let i = 0; i < segmentDataArr.length; i++) {
            for (let j = 0; j < segmentDataArr[i].length; j++) {
                this.bufferSet(segmentStartIndices[i] + j, segmentDataArr[i][j]);
            }
        }
        this._holesArr.shift();
        return true;
    }

    isGraphEmpty() {
        return this._graphLen === 0;
    }

    getGraphMean() {
        return this._mean;
    }

    getSeismogram() {
        let seismogram = new seisplotjs.seismogram.Seismogram(this._segmentTemplate);
        if (this._graphLen === 0) {
            return seismogram;
        }
        seismogram.segments[0] = this.getSegment(this.getGraph(), 0);
        return seismogram;
    }

    getSegment(yData, startIndex) {
        let dataStartMillis = this.startTime + this._millisPerSample * startIndex;
        let luxonStartTime = seisplotjs.luxon.DateTime.fromMillis(dataStartMillis);
        return this._segmentTemplate.cloneWithNewData(yData, luxonStartTime);
    }

    getGraph() {
        return this.bufferSlice(0, this._graphLen);
    }

    getQueue() {
        return this.bufferSlice(this._partitionIndex, this._partitionIndex + this._queueLen);
    }

    bufferSlice(start, end) {
        if (start === end) {
            return this._dataArr.slice(0, 0);
        }
        let retArr = [];
        let index1 = changeLoopIndex(this._bufferStartIndex, start, this.bufferLen);
        let index2 = changeLoopIndex(this._bufferStartIndex, end, this.bufferLen);
        if (index1 < index2) {
            retArr = this._dataArr.slice(index1, index2);
        } else {
            retArr = new BufferArrayClass([
                ...this._dataArr.slice(index1),
                ...this._dataArr.slice(0, index2)
            ]);
        }
        return retArr;
    }

    shiftLeft(repetitions = 1) {
        this._bufferStartIndex = changeLoopIndex(this._bufferStartIndex, repetitions, this.bufferLen);
        this.startTime += this._millisPerSample * repetitions;
    }

    bufferGet(index) {
        return this._dataArr[changeLoopIndex(this._bufferStartIndex, index, this.bufferLen)];
    }

    bufferSet(index, value) {
        this._dataArr[changeLoopIndex(this._bufferStartIndex, index, this.bufferLen)] = value;
    }

}

function isHoleDataValid(graphQueueBuffer, holeDataArr, segmentStartIndices, holeStart, holeEnd) {
    if (graphQueueBuffer._holesArr.length === 0) {
        console.log("[WARNING] Cannot fill first hole, since there are currently no holes!");
        return false;
    }
    let { startIndex, endIndex, arrLen } = analyzeHoleData(holeDataArr, segmentStartIndices);
    if (startIndex > holeStart) {
        console.log("[WARNING] Given data starts after the first hole!");
        return false;
    }
    if (endIndex <= holeEnd) {
        console.log("[WARNING] Given data does not reach the end of the first hole!");
        return false;
    }
    if (arrLen !== holeEnd - holeStart + 1) {
        console.log("[WARNING] Given data for hole patch is discontinuous!");
    }
    return true;
}

function analyzeHoleData(holeDataArr, segmentStartIndices) {
    let startIndex = Infinity;
    let endIndex = 0;
    let arrLen = 0;
    for (let i = 0; i < segmentStartIndices.length; i++) {
        if (segmentStartIndices[i] < startIndex) {
            startIndex = segmentStartIndices[i];
        }
        if (segmentStartIndices[i] + holeDataArr[i].length > endIndex) {
            endIndex = segmentStartIndices[i] + holeDataArr[i].length;
        }
        arrLen += holeDataArr.length;
    }
    return { startIndex, endIndex, arrLen };
}

function getDataFromSeismogramSegment(seismogramSegment, graphQueueBuffer) {
    const { startTime, _millisPerSample } = graphQueueBuffer;
    let startOffsetMillis = seismogramSegment.startTime.toMillis() - startTime;
    if (startOffsetMillis < 0) {
        console.log("[WARNING] Given segment begins before startTime.");
        return false;
    }
    let indicesFromStart = Math.floor(startOffsetMillis / _millisPerSample);

    return {
        _dataArr: seismogramSegment.y,
        startIndex: indicesFromStart
    };
}

function changeLoopIndex(index, amt, loopLen) {
    let newIndex = index + amt;
    // If newIndex is undefined or null, or loop is empty, return original
    if ((newIndex !== 0 && !newIndex) || loopLen <= 0) {
        return index;
    }

    if (newIndex >= loopLen) {
        return newIndex % loopLen;
    } else if (newIndex < 0) {
        return (newIndex % loopLen) + loopLen;
    } else {
        return newIndex;
    }
}