import * as seisplotjs from "./seisplotjs_3.0.0-alpha.1_standalone.mjs";


const BufferArrayClass = Int32Array;

export class GraphQueueBuffer {

    constructor(seismogram, plotMins) {
        this.bufferLen = Math.floor(60 * plotMins * seismogram.sampleRate);
        this.sampleRate = seismogram.sampleRate;
        this._millisPerSample = 1000 / this.sampleRate;
        this.startTime = seismogram.startTime.toMillis();
        this.segmentTemplate = seismogram.segments[0].cloneWithNewData([]);
        this.dataArr = new BufferArrayClass(this.bufferLen);
        this.holesArr = [];
        this.bufferStartIndex = 0;
        this.partitionIndex = 0;
        this.graphLen = 0;
        this.queueLen = 0;
        for (let i = 0; i < seismogram.segments.length; i++) {
            this.addSegment(seismogram.segments[i]);
        }
    }

    addSegment(seismogramSegment) {
        let { dataArr, startIndex } = getDataFromSeismogramSegment(seismogramSegment, this);
        let offsetIndex = startIndex - (this.graphLen + this.queueLen);
        if (offsetIndex < 0) {
            console.error("Cannot add a segment before last inserted data! " +
                          "If trying to patch a hole, please use patchFirstHole()");
        }

        if (offsetIndex > 0) {
            // Hole start and end indices are both inclusive
            this.holesArr.push([
                this.graphLen + this.queueLen,
                this.graphLen + this.queueLen + offsetIndex - 1
            ]);
            let last = this.holesArr.length - 1;
            if (last > 0 && this.holesArr[last - 1][1] > this.holesArr[last][0]) {
                console.error("New hole is not further in time than past holes!");
            }
        }

        this.addData(dataArr, offsetIndex);
    }

    addData(data, offsetIndex = 0) {
        if (!data) {
            console.log("[WARNING] addData is being called without any input!");
            return;
        }
        if (data.length === undefined) {
            data = [data];
        }

        data = [...data];
        let queueSpacesLeft = this.bufferLen - (this.partitionIndex + this.queueLen/* + offsetIndex*/);
        // TEMP - soon, holes won't exist in the graph, but while they still do, fill where the holes
        //        are with 0's
        for (let i = 0; i < offsetIndex; i++) {
            data.unshift(0);
        }
        
        let staticData = [];
        let cycleData = [];
        if (queueSpacesLeft <= 0) {
            cycleData = data.slice();
        } else {
            staticData = data.slice(0, queueSpacesLeft);
            cycleData = data.slice(queueSpacesLeft);
        }
        this._addDataWhileNotFull(staticData, 0);
        this._addDataWhileFull(cycleData, 0);
    }

    _addDataWhileNotFull(data, offsetIndex) {
        this.queueLen += data.length > 0 ? offsetIndex : 0;
        for (let i = 0; i < data.length; i++) {
            this.bufferSet(this.partitionIndex + this.queueLen + offsetIndex, data[i]);
            this.queueLen++;
        }
    }

    _addDataWhileFull(data, offsetIndex) {
        let repetitions = data.length + offsetIndex;
        for (let i = 0; i < repetitions; i++) {
            if (this.partitionIndex > 0) {
                this.partitionIndex--;
                this.graphLen--;
                this.queueLen++;
            }
            this.shiftLeft();
            if (i >= offsetIndex) {
                this.bufferSet(this.bufferLen - 1, data[i]);
            }
        }
    }

    // Returns an object with these keys:
    //  startTime: time of the start of the hole in milliseconds from the epoch
    //  endTime: time of the end of the hole in milliseconds from the epoch
    getFirstHole() {
        if (this.holesArr.length === 0) {
            return;
        }
        let [ startIndex, endIndex ] = this.holesArr[0];
        return {
            startTime: startIndex * this._millisPerSample + this.startTime,
            endTime: endIndex * this._millisPerSample + this.startTime
        };
    }

    patchFirstHoleWithSegment(seismogramSegment) {
        let { dataArr, startIndex } = getDataFromSeismogramSegment(seismogramSegment, this);
        this.patchFirstHole(dataArr, startIndex);
    }

    patchFirstHole(dataArr, segmentStartIndex) {
        if (this.holesArr.length === 0) {
            console.error("Cannot fill first hole, since there are currently no holes!");
            return;
        }
        const [ holeStart, holeEnd ] = this.holesArr[0];
        if (segmentStartIndex > holeStart) {
            console.error("Given data starts after the first hole!");
            return;
        }
        if (segmentStartIndex + dataArr.length <= holeEnd) {
            console.error("Given data does not reach the end of the first hole!");
            return;
        }
        for (let i = holeStart; i <= holeEnd; i++) {
            this.bufferSet(i, dataArr[i - segmentStartIndex]);
        }
        this.holesArr.shift();
    }

    updateGraph(numValues) {
        if (numValues === undefined) {
            numValues = this.queueLen;
        }
        // Limit values in graph to be before the first hole if applicable
        if (this.holesArr.length > 0 && this.partitionIndex + numValues > this.holesArr[0][0]) {
            numValues = this.holesArr[0][0] - this.partitionIndex;
        }
        this.partitionIndex += numValues;
        this.queueLen -= numValues;
        if (this.partitionIndex >= this.bufferLen) {
            this.partitionIndex = this.bufferLen - 1;
        }
        if (this.queueLen < 0) {
            this.queueLen = 0;
        }
    
        let currIndex = this.partitionIndex - 1;
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
            this.graphLen = currIndex + 1;
        }
        let newValuesStartIndex = this.graphLen - numValues;
        if (numValues > 0) {
            let dataAddedArr = this.bufferSlice(newValuesStartIndex, newValuesStartIndex + numValues);
            return this.getSegment(dataAddedArr, newValuesStartIndex);
        }
        return false;
    }

    getSeismogram() {
        let seismogram = new seisplotjs.seismogram.Seismogram(this.segmentTemplate);
        if (this.graphLen === 0) {
            return seismogram;
        }
        seismogram.segments[0] = this.getSegment(this.getGraph(), 0);
        return seismogram;
    }

    getSegment(yData, startIndex) {
        let dataStartMillis = this.startTime + this._millisPerSample * startIndex;
        let luxonStartTime = seisplotjs.luxon.DateTime.fromMillis(dataStartMillis);
        return this.segmentTemplate.cloneWithNewData(yData, luxonStartTime);
    }

    printAll() {
        console.log("Graph: ", this.getGraph(), ", Queue: ", this.getQueue());
    }

    getGraph() {
        return this.bufferSlice(0, this.graphLen);
    }

    getQueue() {
        return this.bufferSlice(this.partitionIndex, this.partitionIndex + this.queueLen);
    }

    bufferSlice(start, end) {
        if (start === end) {
            return this.dataArr.slice(0, 0);
        }
        let retArr = [];
        let index1 = changeLoopIndex(this.bufferStartIndex, start, this.bufferLen);
        let index2 = changeLoopIndex(this.bufferStartIndex, end, this.bufferLen);
        if (index1 < index2) {
            retArr = this.dataArr.slice(index1, index2);
        } else {
            retArr = new BufferArrayClass([
                ...this.dataArr.slice(index1),
                ...this.dataArr.slice(0, index2)
            ]);
        }
        return retArr;
    }

    shiftLeft(repetitions = 1) {
        this.bufferStartIndex = changeLoopIndex(this.bufferStartIndex, repetitions, this.bufferLen);
        this.startTime += this._millisPerSample * repetitions;
    }

    bufferGet(index) {
        return this.dataArr[changeLoopIndex(this.bufferStartIndex, index, this.bufferLen)];
    }

    bufferSet(index, value) {
        this.dataArr[changeLoopIndex(this.bufferStartIndex, index, this.bufferLen)] = value;
    }

}

function getDataFromSeismogramSegment(seismogramSegment, graphQueueBuffer) {
    const { startTime, _millisPerSample } = graphQueueBuffer;
    let startOffsetMillis = seismogramSegment.startTime.toMillis() - startTime;
    if (startOffsetMillis < 0) {
        console.error("Given segment begins before startTime!");
    }
    let indicesFromStart = Math.floor(startOffsetMillis / _millisPerSample);

    return {
        dataArr: seismogramSegment.y,
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