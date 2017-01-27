/*
Copyright 2016 OCAD University

Licensed under the Educational Community License (ECL), Version 2.0 or the New
BSD license. You may not use this file except in compliance with one these
Licenses.

You may obtain a copy of the ECL 2.0 License and BSD License at
https://github.com/fluid-project/infusion/raw/master/Infusion-LICENSE.txt
*/

var fluid_2_0_0 = fluid_2_0_0 || {};
(function ($, fluid) {
    "use strict";

    fluid.registerNamespace("fluid.stateTracker");

    fluid.defaults("fluid.stateTracker", {
        gradeNames: ["fluid.modelComponent"],
        members: {
            // default polling frequency in msec.
            interval: 10
        },
        invokers: {
            startTracking: {
                funcName: "fluid.stateTracker.startTracking",
                args: ["{that}", "{arguments}.0"]
                                 // polling interval
            },
            stopTracking: {
                funcName: "fluid.stateTracker.stopTracking",
                args: ["{arguments}.0"]
                       //intervalID
            },
            evaluateChange: {
                funcName: "fluid.notImplemented"
            }
        }
    });

    /**
     * Initiate polling.
     * @psrsm that {Component} An instance of fluid.stateTracker
     * @param interval {Number} optional delay between calls to check the state's current value (msec).
     * @return {Number}the intervalID.
     */
    fluid.stateTracker.startTracking = function (that, interval) {
        if (interval) {
            that.interval = interval;
        }
        return setInterval(function () {that.evaluateChange();}, that.interval);
    };

    /**
     * Stop polling.
     * @psrsm that {Component} An instance of fluid.stateTracker
     * @param intervalID {Object} the interval to clear.
     */
    fluid.stateTracker.stopTracking = function (intervalID) {
        clearInterval(intervalID);
    };

})(jQuery, fluid_2_0_0);
