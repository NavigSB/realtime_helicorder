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
        this.bufferStartIndex = 0;
        this.partitionIndex = 0;
        this.graphLen = 0;
        this.queueLen = 0;
        for (let i = 0; i < seismogram.segments.length; i++) {
            this.addSegment(seismogram.segments[i]);
        }
    }

    addSegment(seismogramSegment) {
        this.addData(seismogramSegment.y);
    }

    addData(data) {
        if (!data) {
            console.log("[WARNING] addData is being called without any input!");
            return;
        }
        if (data.length === undefined) {
            data = [data];
        }
    
        let dataLeft = this.bufferLen - (this.partitionIndex + this.queueLen);
        let staticData = [];
        let cycleData = [];
        if (dataLeft === 0) {
            cycleData = data.slice();
        } else {
            staticData = data.slice(0, dataLeft);
            cycleData = data.slice(dataLeft);
        }
    
        this._addDataWhileNotFull(staticData);
        this._addDataWhileFull(cycleData);
    }

    _addDataWhileNotFull(data) {
        for (let i = 0; i < data.length; i++) {
            this.bufferSet(this.partitionIndex + this.queueLen, data[i]);
            this.queueLen++;
        }
    }

    _addDataWhileFull(data) {
        for (let i = 0; i < data.length; i++) {
            if (this.partitionIndex > 0) {
                this.partitionIndex--;
                this.graphLen--;
                this.queueLen++;
            }
            this.shiftLeft();
            this.bufferSet(this.bufferLen - 1, data[i]);
        }
    }

    updateGraph(numValues) {
        if (numValues === undefined) {
            numValues = this.queueLen;
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
        let dataAddedArr = this.bufferSlice(newValuesStartIndex, newValuesStartIndex + numValues);
        return this.getSegment(dataAddedArr, newValuesStartIndex);
    }

    getSeismogram() {
        let seismogram = new seisplotjs.seismogram.Seismogram(this.segmentTemplate);
        if (this.graphLen === 0) {
            return seismogram;
        }
        seismogram.segments[0] = this.getSegment(this.getGraph(), 0);
        return seismogram;
    }

    getSegment(yData, bufferStartIndex) {
        let dataStartMillis = this.startTime + this._millisPerSample * bufferStartIndex;
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
        // (1000/sampleRate) represents the amount of milliseconds that each sample represents  
        this.startTime += this._millisPerSample * repetitions;
    }

    bufferGet(index) {
        return this.dataArr[changeLoopIndex(this.bufferStartIndex, index, this.bufferLen)];
    }

    bufferSet(index, value) {
        this.dataArr[changeLoopIndex(this.bufferStartIndex, index, this.bufferLen)] = value;
    }

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