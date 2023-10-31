import { MaximumStatistic, MeanStatistic, MinimumStatistic } from "./arrayStats.mjs";
import * as seisplotjs from "./seisplotjs_3.1.1_standalone.mjs";


const BufferArrayClass = Int32Array;

export class GraphQueueBuffer {

    // getPlotStartFunction: Get graph start in millis from epoch
    constructor(seismogram, plotMinsMax, getPlotStartFunction) {
        this.bufferLen = Math.floor(60 * plotMinsMax * seismogram.sampleRate);
        this.sampleRate = seismogram.sampleRate;
        this.startTime = seismogram.startTime.toMillis();
        this.getPlotStart = getPlotStartFunction;
        this.plotStart = this.getPlotStart();
        console.log("The GraphQueueBuffer has an initial start time of: " + new Date(this.plotStart).toString());
        this._millisPerSample = 1000 / this.sampleRate;
        this._dataArr = new BufferArrayClass(this.bufferLen);
        this._dataArr.fill(-2500);
        this._bufferStartIndex = 0;
        this._partitionIndex = 0;
        this._graphLen = 0;
        this._queueLen = 0;
        this._getStatisticIndex = (i) => {
            let plotStartIndex = Math.floor((this.plotStart - this.startTime) / this._millisPerSample);
            return this.bufferGet(plotStartIndex + i);
        };
        this._getStatisticPlotLen = () => {
            let plotStartIndex = Math.floor((this.plotStart - this.startTime) / this._millisPerSample);
            return this.graphLen - plotStartIndex;
        };
        this._statistics = {
            mean: new MeanStatistic(this._getStatisticIndex, this._getStatisticPlotLen),
            maximum: new MaximumStatistic(this._getStatisticIndex, this._getStatisticPlotLen),
            minimum: new MinimumStatistic(this._getStatisticIndex, this._getStatisticPlotLen)
        };
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

        console.log("Legit just adding " + data.length + " values using addData... This represents " + ((data.length * this._millisPerSample) / (1000 * 60) + " mins of data"));

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

        console.log("Just finished addData... Graph = " + ((this._graphLen * this._millisPerSample) / (1000 * 60)) + " mins (" + this._graphLen + " values) and queue = " + ((this._queueLen * this._millisPerSample) / (1000 * 60)) + " mins (" + this._queueLen + " values).");

        return true;
    }

    _addDataWhileNotFull(data, offsetIndex) {
        this._queueLen += data.length > 0 ? offsetIndex : 0;
        for (let i = 0; i < data.length; i++) {
            this.bufferSet(this._partitionIndex + this._queueLen, data[i]);
            this._queueLen++;
        }
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
        // TODO: It's something about the ordering of the removal and addition parts in here... Maybe merge 'em?
        console.log("Calling updateGraph with " + numValues + " values!");
        if (numValues === undefined) {
            numValues = this._queueLen;
        }
        console.log("Okay found out the queue has " + numValues + " values! Going for it...");
        // Limit values in graph to be before the first hole if applicable
        if (this._holesArr.length > 0 && this._partitionIndex + numValues > this._holesArr[0][0]) {
            numValues = this._holesArr[0][0] - this._partitionIndex;
            console.log("Wait wait wait, actually " + numValues + " values. NOW go for it");
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
        
        let oldPlotStart = this.plotStart;
        this.plotStart = this.getPlotStart();
        if (this.plotStart !== oldPlotStart) {
            // TODO: Well, I think this code below's doing the right thing, but... There's some errors. Not exactly sure what's happening.
            //         Whatever it is, I'm quite positive we shouldn't be adding 8340000 values that immediately get removed. Anyway, good luck!
            // If new start moves forward, remove those values. If new start moves backward, add new values.
            let startIndex = (Math.min(this.plotStart, oldPlotStart) - this.startTime) / this._millisPerSample;
            let endIndex = startIndex + Math.abs(this.plotStart - oldPlotStart) / this._millisPerSample;
            // console.log(this.sampleRate + " Hz = " + this._millisPerSample + " ms/sample. This gives us ");
            console.log("Just for transparency, there are currently " + ((this._graphLen * this._millisPerSample) / (1000 * 60)) + " mins of data in the graph rn");
            console.log(((oldPlotStart >= this.plotStart) ? "Adding" : "Removing") + " " + (((endIndex - startIndex) * this._millisPerSample) / (1000 * 60)) + " mins of data that go from " + new Date(Math.min(this.plotStart, oldPlotStart)).toString() + " -> " + new Date(Math.max(this.plotStart, oldPlotStart)).toString() + " because the start time changed...");
            console.log("Btw, indices are: " + startIndex + " and " + endIndex + ". For contrast, the whole array is: " + this._dataArr.length + " values");
            for (let i = startIndex; i < endIndex; i++) {
                if (oldPlotStart < this.plotStart) {
                    this._updateStatistics(this.bufferGet(i), null);
                } else {
                    this._updateStatistics(null, this.bufferGet(i));
                }
            }
        }

        let newValuesStartIndex = this._graphLen - numValues;
        if (numValues > 0) {
            let dataAddedArr = this.bufferSlice(newValuesStartIndex, newValuesStartIndex + numValues);
            console.log("Adding " + dataAddedArr.length + " values because we called graphUpdate... This represents " + ((dataAddedArr.length * this._millisPerSample) / (1000 * 60) + " mins of data"));
            // Update statistics with newValues
            for (let i = 0; i < dataAddedArr.length; i++) {
                this._updateStatistics(null, dataAddedArr[i]);
            }
            console.log("Just finished updateGraph... Graph = " + ((this._graphLen * this._millisPerSample) / (1000 * 60)) + " mins (" + this._graphLen + " values) and queue = " + ((this._queueLen * this._millisPerSample) / (1000 * 60)) + " mins (" + this._queueLen + " values).");
            return this.getSegment(dataAddedArr, newValuesStartIndex);
        }

        console.log("Finished updateGraph but couldn't do it somehow");
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

    getStatistics() {
        let stats = {};
        let statNames = Object.keys(this._statistics);
        for (let i = 0; i < statNames.length; i++) {
            stats[statNames[i]] = this._statistics[statNames[i]].getValue();
        }
        return stats;
    }

    _updateStatistics(oldValue, newValue) {
        let statNames = Object.keys(this._statistics);
        for (let i = 0; i < statNames.length; i++) {
            this._statistics[statNames[i]].update(oldValue, newValue);
        }
    }

    getSeismogram() {
        if (this._graphLen === 0) {
            return null;
        }
        let seisSeg = this.getSegment(this.getGraph(), 0);
        return new seisplotjs.seismogram.Seismogram(seisSeg);
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
        // TODO: Might want to remove this part later... We'll see
        for (let i = 0; i < repetitions; i++) {
            // let oldVal = this.bufferGet(0);
            // let newVal = this.bufferGet(this._graphLen);
            // Do actual shift
            this._bufferStartIndex = changeLoopIndex(this._bufferStartIndex, 1, this.bufferLen);
            // Update statistics when values leave the graph
            // this._updateStatistics(oldVal, newVal);
        }
        // Move start time back the number of samples removed
        this.startTime += this._millisPerSample * repetitions;
    }

    bufferGet(index) {
        return this._dataArr[changeLoopIndex(this._bufferStartIndex, index, this.bufferLen)];
    }

    bufferSet(index, value) {
        let absoluteIndex = changeLoopIndex(this._bufferStartIndex, index, this.bufferLen);
        this._dataArr[absoluteIndex] = value;
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