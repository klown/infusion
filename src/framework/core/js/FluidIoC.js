/*
Copyright 2011-2013 OCAD University
Copyright 2010-2015 Lucendo Development Ltd.

Licensed under the Educational Community License (ECL), Version 2.0 or the New
BSD license. You may not use this file except in compliance with one these
Licenses.

You may obtain a copy of the ECL 2.0 License and BSD License at
https://github.com/fluid-project/infusion/raw/master/Infusion-LICENSE.txt
*/

var fluid_2_0 = fluid_2_0 || {};

(function ($, fluid) {
    "use strict";
    
    /** NOTE: The contents of this file are by default NOT PART OF THE PUBLIC FLUID API unless explicitly annotated before the function **/

    /** The Fluid "IoC System proper" - resolution of references and
     * completely automated instantiation of declaratively defined
     * component trees */

    // Currently still uses manual traversal - once we ban manually instantiated components,
    // it will use the instantiator's records instead.
    fluid.visitComponentChildren = function (that, visitor, options, segs) {
        segs = segs || [];
        for (var name in that) {
            var component = that[name];
            // This entire algorithm is primitive and expensive and will be removed once we can abolish manual init components
            if (!fluid.isComponent(component) || (options.visited && options.visited[component.id])) {
                continue;
            }
            segs.push(name);
            if (options.visited) { // recall that this is here because we may run into a component that has been cross-injected which might otherwise cause cyclicity
                options.visited[component.id] = true;
            }
            if (visitor(component, name, segs, segs.length - 1)) {
                return true;
            }
            if (!options.flat) {
                fluid.visitComponentChildren(component, visitor, options, segs);
            }
            segs.pop();
        }
    };
    
    fluid.getContextHash = function (instantiator, that) {
        var shadow = instantiator.idToShadow[that.id];
        return shadow && shadow.contextHash;
    };
    
    fluid.componentHasGrade = function (that, gradeName) {
        var contextHash = fluid.getContextHash(fluid.globalInstantiator, that);
        return !!(contextHash && contextHash[gradeName]);
    };
    
    // A variant of fluid.visitComponentChildren that supplies the signature expected for fluid.matchIoCSelector
    // this is: thatStack, contextHashes, memberNames, i - note, the supplied arrays are NOT writeable and shared through the iteration
    fluid.visitComponentsForMatching = function (that, options, visitor) {
        var instantiator = fluid.getInstantiator(that);
        options = $.extend({
            visited: {},
            instantiator: instantiator
        }, options);
        var thatStack = [that];
        var contextHashes = [fluid.getContextHash(instantiator, that)];
        var visitorWrapper = function (component, name, segs) {
            thatStack.length = 1;
            contextHashes.length = 1;
            for (var i = 0; i < segs.length; ++ i) {
                var child = thatStack[i][segs[i]];
                thatStack[i + 1] = child;
                contextHashes[i + 1] = fluid.getContextHash(instantiator, child) || {};
            }
            return visitor(component, thatStack, contextHashes, segs, segs.length);
        };
        fluid.visitComponentChildren(that, visitorWrapper, options, []);
    };

    fluid.getMemberNames = function (instantiator, thatStack) {
        var path = instantiator.idToPath(thatStack[thatStack.length - 1].id);
        var segs = instantiator.parseEL(path);
            // Shortness in the stack will be caused by dynamicEnvironment or other junk which has no member name
        segs.unshift.apply(segs, fluid.generate(thatStack.length - segs.length, ""));
        
        return segs;
    };

    // thatStack contains an increasing list of MORE SPECIFIC thats.
    // this visits all components starting from the current location (end of stack)
    // in visibility order UP the tree.
    fluid.visitComponentsForVisibility = function (instantiator, thatStack, visitor, options) {
        options = options || {
            visited: {},
            flat: true,
            instantiator: instantiator
        };
        var memberNames = fluid.getMemberNames(instantiator, thatStack);
        for (var i = thatStack.length - 1; i >= 0; --i) {
            var that = thatStack[i];

            // explicitly visit the direct parent first
            options.visited[that.id] = true;
            if (visitor(that, memberNames[i], memberNames, i)) {
                return;
            }
            
            if (fluid.visitComponentChildren(that, visitor, options, memberNames)) {
                return;
            }
            memberNames.pop();
        }
    };

    fluid.mountStrategy = function (prefix, root, toMount) {
        var offset = prefix.length;
        return function (target, name, i, segs) {
            if (i <= prefix.length) { // Avoid OOB to not trigger deoptimisation!
                return;
            }
            for (var j = 0; j < prefix.length; ++ j) {
                if (segs[j] !== prefix[j]) {
                    return;
                }
            }
            return toMount(target, name, i - prefix.length, segs.slice(offset));
        };
    };

    fluid.invokerFromRecord = function (invokerec, name, that) {
        fluid.pushActivity("makeInvoker", "beginning instantiation of invoker with name %name and record %record as child of %that",
            {name: name, record: invokerec, that: that});
        var invoker = fluid.makeInvoker(that, invokerec, name);
        fluid.popActivity();
        return invoker;
    };

    fluid.memberFromRecord = function (memberrec, name, that) {
        // TODO: Try to understand why we supply this "freeRoot" option
        var value = fluid.expandOptions(memberrec, that, null, null, {freeRoot: true});
        return value;
    };

    fluid.recordStrategy = function (that, options, optionsStrategy, recordPath, recordMaker, prefix) {
        prefix = prefix || [];
        return {
            strategy: function (target, name, i) {
                if (i !== 1) {
                    return;
                }
                var record = fluid.driveStrategy(options, [recordPath, name], optionsStrategy);
                if (record === undefined) {
                    return;
                }
                fluid.set(target, [name], fluid.inEvaluationMarker);
                var member = recordMaker(record, name, that);
                fluid.set(target, [name], member);
                return member;
            },
            initter: function () {
                var records = fluid.driveStrategy(options, recordPath, optionsStrategy) || {};
                for (var name in records) {
                    fluid.getForComponent(that, prefix.concat([name]));
                }
            }
        };
    };

    // patch Fluid.js version for timing
    fluid.instantiateFirers = function (that) {
        var shadow = fluid.shadowForComponent(that);
        var initter = fluid.get(shadow, ["eventStrategyBlock", "initter"]) || fluid.identity;
        initter();
    };

    fluid.makeDistributionRecord = function (contextThat, sourceRecord, sourcePath, targetSegs, exclusions, offset, sourceType) {
        offset = offset || 0;
        sourceType = sourceType || "distribution";

        var source = fluid.copy(fluid.get(sourceRecord, sourcePath));
        fluid.each(exclusions, function (exclusion) {
            fluid.model.applyChangeRequest(source, {segs: exclusion, type: "DELETE"});
        });

        var record = {options: {}};
        fluid.model.applyChangeRequest(record, {segs: targetSegs, type: "ADD", value: source});
        return $.extend(record, {contextThat: contextThat, recordType: sourceType, priority: fluid.mergeRecordTypes.distribution + offset});
    };

    // Part of the early "distributeOptions" workflow. Given the description of the blocks to be distributed, assembles "canned" records
    // suitable to be either registered into the shadow record for later or directly pushed to an existing component, as well as honouring
    // any "removeSource" annotations by removing these options from the source block.
    fluid.filterBlocks = function (contextThat, sourceBlocks, sourceSegs, targetSegs, exclusions, removeSource) {
        var togo = [], offset = 0;
        fluid.each(sourceBlocks, function (block) {
            var source = fluid.get(block.source, sourceSegs);
            if (source) {
                togo.push(fluid.makeDistributionRecord(contextThat, block.source, sourceSegs, targetSegs, exclusions, offset++, block.recordType));
                var rescued = $.extend({}, source);
                if (removeSource) {
                    fluid.model.applyChangeRequest(block.source, {segs: sourceSegs, type: "DELETE"});
                }
                fluid.each(exclusions, function (exclusion) {
                    var orig = fluid.get(rescued, exclusion);
                    fluid.set(block.source, sourceSegs.concat(exclusion), orig);
                });
            }
        });
        return togo;
    };

    // Use this peculiar signature since the actual component and shadow itself may not exist yet. Perhaps clean up with FLUID-4925
    fluid.noteCollectedDistribution = function (parentShadow, memberName, distribution) {
        fluid.model.setSimple(parentShadow, ["collectedDistributions", memberName, distribution.id], true);
    };

    fluid.isCollectedDistribution = function (parentShadow, memberName, distribution) {
        return fluid.model.getSimple(parentShadow, ["collectedDistributions", memberName, distribution.id]);
    };

    fluid.clearCollectedDistributions = function (parentShadow, memberName) {
        fluid.model.applyChangeRequest(parentShadow, {segs: ["collectedDistributions", memberName], type: "DELETE"});
    };

    fluid.collectDistributions = function (distributedBlocks, parentShadow, distribution, thatStack, contextHashes, memberNames, i) {
        var lastMember = memberNames[memberNames.length - 1];
        if (!fluid.isCollectedDistribution(parentShadow, lastMember, distribution) &&
                fluid.matchIoCSelector(distribution.selector, thatStack, contextHashes, memberNames, i)) {
            distributedBlocks.push.apply(distributedBlocks, distribution.blocks);
            fluid.noteCollectedDistribution(parentShadow, lastMember, distribution);
        }
    };

    // Slightly silly function to clean up the "appliedDistributions" records. In general we need to be much more aggressive both
    // about clearing instantiation garbage (e.g. onCreate and most of the shadow)
    // as well as caching frequently-used records such as the "thatStack" which
    // would mean this function could be written in a sensible way
    fluid.registerCollectedClearer = function (shadow, parentShadow, memberName) {
        if (!shadow.collectedClearer && parentShadow) {
            shadow.collectedClearer = function () {
                fluid.clearCollectedDistributions(parentShadow, memberName);
            };
        }
    };

    fluid.receiveDistributions = function (parentThat, gradeNames, memberName, that) {
        var instantiator = fluid.getInstantiator(parentThat || that);
        var thatStack = instantiator.getThatStack(parentThat || that); // most specific is at end
        thatStack.unshift(fluid.rootComponent);
        var memberNames = fluid.getMemberNames(instantiator, thatStack);
        var distributedBlocks = [];
        var shadows = fluid.transform(thatStack, function (thisThat) {
            return instantiator.idToShadow[thisThat.id];
        });
        var parentShadow = shadows[shadows.length - (parentThat ? 1 : 2)];
        var contextHashes = fluid.getMembers(shadows, "contextHash");
        if (parentThat) { // if called before construction of component from assembleCreatorArguments - NB this path will be abolished/amalgamated
            memberNames.push(memberName);
            contextHashes.push(fluid.gradeNamesToHash(gradeNames));
            thatStack.push(that);
        } else {
            fluid.registerCollectedClearer(shadows[shadows.length - 1], parentShadow, memberNames[memberNames.length - 1]);
        }
        // This use of function creation within a loop is acceptable since
        // the function does not attempt to close directly over the loop counter
        for (var i = 0; i < thatStack.length - 1; ++ i) {
            fluid.each(shadows[i].distributions, function (distribution) {
                fluid.collectDistributions(distributedBlocks, parentShadow, distribution, thatStack, contextHashes, memberNames, i);
            });  /* function in loop */ /* jshint ignore:line */
        }
        return distributedBlocks;
    };

    // convert "preBlocks" as produced from fluid.filterBlocks into "real blocks" suitable to be used by the expansion machinery.
    fluid.applyDistributions = function (that, preBlocks, targetShadow) {
        var distributedBlocks = fluid.transform(preBlocks, function (preBlock) {
            return fluid.generateExpandBlock(preBlock, that, targetShadow.mergePolicy);
        });
        var mergeOptions = targetShadow.mergeOptions;
        mergeOptions.mergeBlocks.push.apply(mergeOptions.mergeBlocks, distributedBlocks);
        mergeOptions.updateBlocks();
        return distributedBlocks;
    };
    
    // TODO: This implementation is obviously poor and has numerous flaws - in particular it does no backtracking as well as matching backwards through the selector
    fluid.matchIoCSelector = function (selector, thatStack, contextHashes, memberNames, i) {
        var thatpos = thatStack.length - 1;
        var selpos = selector.length - 1;
        while (true) {
            var mustMatchHere = thatpos === thatStack.length - 1 || selector[selpos].child;

            var that = thatStack[thatpos];
            var selel = selector[selpos];
            var match = true;
            for (var j = 0; j < selel.predList.length; ++j) {
                var pred = selel.predList[j];
                if (pred.context && !(contextHashes[thatpos][pred.context] || memberNames[thatpos] === pred.context)) {
                    match = false;
                    break;
                }
                if (pred.id && that.id !== pred.id) {
                    match = false;
                    break;
                }
            }
            if (selpos === 0 && thatpos > i && mustMatchHere) {
                match = false; // child selector must exhaust stack completely - FLUID-5029
            }
            if (match) {
                if (selpos === 0) {
                    return true;
                }
                --thatpos;
                --selpos;
            }
            else {
                if (mustMatchHere) {
                    return false;
                }
                else {
                    --thatpos;
                }
            }
            if (thatpos < i) {
                return false;
            }
        }
    };
    
    /** Query for all components matching a selector in a particular tree
     * @param root {Component} The root component at which to start the search
     * @param selector {String} An IoCSS selector, in form of a string. Note that since selectors supplied to this function implicitly
     * match downwards, they need not contain the "head context" followed by whitespace required in the distributeOptions form. E.g.
     * simply <code>"fluid.viewComponent"</code> will match all viewComponents below the root.
     * @param flat {Boolean} [Optional] <code>true</code> if the search should just be performed at top level of the component tree
     * Note that with <code>flat=true</code> this search will scan every component in the tree and may well be very slow.
     */
    // supported, PUBLIC API function 
    fluid.queryIoCSelector = function (root, selector, flat) {
        var parsed = fluid.parseSelector(selector, fluid.IoCSSMatcher);
        var togo = [];

        fluid.visitComponentsForMatching(root, {flat: flat}, function (that, thatStack, contextHashes, memberNames, i) {
            if (fluid.matchIoCSelector(parsed, thatStack, contextHashes, memberNames, i)) {
                togo.push(that);
            }
        });
        return togo;
    };

    fluid.isIoCSSSelector = function (context) {
        return context.indexOf(" ") !== -1; // simple-minded check for an IoCSS reference
    };

    fluid.pushDistributions = function (targetHead, selector, blocks) {
        var targetShadow = fluid.shadowForComponent(targetHead);
        var id = fluid.allocateGuid();
        var distributions = (targetShadow.distributions = targetShadow.distributions || []);
        distributions.push({
            id: id, // This id is used in clearDistributions
            selector: selector,
            blocks: blocks
        });
        return id;
    };

    fluid.clearDistribution = function (targetHead, id) {
        var targetShadow = fluid.shadowForComponent(targetHead);
        fluid.remove_if(targetShadow.distributions, function (distribution) {
            return distribution.id === id;
        });
    };
    
    fluid.clearDistributions = function (shadow) {
        fluid.each(shadow.outDistributions, function (outDist) {
            fluid.clearDistribution(outDist.targetComponent, outDist.distributionId);
        });
    };

    // Modifies a parsed selector to extract and remove its head context which will be matched upwards
    fluid.extractSelectorHead = function (parsedSelector) {
        var predList = parsedSelector[0].predList;
        var context = predList[0].context;
        predList.length = 0;
        return context;
    };
    
    fluid.parseExpectedOptionsPath = function (path, role) {
        var segs = fluid.model.parseEL(path);
        if (segs.length > 1 && segs[0] !== "options") {
            fluid.fail("Error in options distribution path ", path, " - only " + role + " paths beginning with \"options\" are supported");
        }
        return segs.slice(1);
    };

    fluid.undistributableOptions = ["gradeNames", "distributeOptions", "argumentMap", "initFunction", "mergePolicy", "progressiveCheckerOptions"]; // automatically added to "exclusions" of every distribution

    fluid.distributeOptions = function (that, optionsStrategy) {
        var thatShadow = fluid.shadowForComponent(that);
        var records = fluid.driveStrategy(that.options, "distributeOptions", optionsStrategy);
        fluid.each(records, function (record) {
            var targetRef = fluid.parseContextReference(record.target);
            var targetComp, selector, context;
            if (fluid.isIoCSSSelector(targetRef.context)) {
                selector = fluid.parseSelector(targetRef.context, fluid.IoCSSMatcher);
                var headContext = fluid.extractSelectorHead(selector);
                if (headContext === "/") {
                    targetComp = fluid.rootComponent;
                } else {
                    context = headContext;
                }
            }
            else {
                context = targetRef.context;
            }
            targetComp = targetComp || fluid.resolveContext(context, that);
            if (!targetComp) {
                fluid.fail("Error in options distribution record ", record, " - could not resolve context {"+context+"} to a root component");
            }
            var targetSegs = fluid.model.parseEL(targetRef.path);
            var preBlocks;
            if (record.record !== undefined) {
                preBlocks = [(fluid.makeDistributionRecord(that, record.record, [], targetSegs, [], 0))];
            }
            else {
                var source = fluid.parseContextReference(record.source || "{that}.options"); // TODO: This is probably not a sensible default
                if (source.context !== "that") {
                    fluid.fail("Error in options distribution record ", record, " only a context of {that} is supported");
                }
                var sourceSegs = fluid.parseExpectedOptionsPath(source.path, "source");
                var fullExclusions = fluid.makeArray(record.exclusions).concat(sourceSegs.length === 0 ? fluid.undistributableOptions : []);

                var exclusions = fluid.transform(fullExclusions, function (exclusion) {
                    return fluid.model.parseEL(exclusion);
                });

                preBlocks = fluid.filterBlocks(that, thatShadow.mergeOptions.mergeBlocks, sourceSegs, targetSegs, exclusions, record.removeSource);
                thatShadow.mergeOptions.updateBlocks(); // perhaps unnecessary
            }
            // TODO: inline material has to be expanded in its original context!

            if (selector) {
                var distributionId = fluid.pushDistributions(targetComp, selector, preBlocks);
                thatShadow.outDistributions = thatShadow.outDistributions || [];
                thatShadow.outDistributions.push({
                    targetComponent: targetComp,
                    distributionId: distributionId
                });
            }
            else { // The component exists now, we must rebalance it
                var targetShadow = fluid.shadowForComponent(targetComp);
                fluid.applyDistributions(that, preBlocks, targetShadow);
            }
        });
    };

    fluid.gradeNamesToHash = function (gradeNames) {
        var contextHash = {};
        fluid.each(gradeNames, function (gradeName) {
            contextHash[gradeName] = true;
            contextHash[fluid.computeNickName(gradeName)] = true;
        });
        return contextHash;
    };

    fluid.cacheShadowGrades = function (that, shadow) {
        var contextHash = fluid.gradeNamesToHash(that.options.gradeNames);
        contextHash[that.nickName] = true;
        shadow.contextHash = contextHash;
    };

    // First sequence point where the mergeOptions strategy is delivered from Fluid.js - here we take care
    // of both receiving and transmitting options distributions
    fluid.deliverOptionsStrategy = function (that, target, mergeOptions) {
        var shadow = fluid.shadowForComponent(that, shadow);
        fluid.cacheShadowGrades(that, shadow);
        shadow.mergeOptions = mergeOptions;
    };

    fluid.expandDynamicGrades = function (that, shadow, gradeNames, dynamicGrades) {
        var resolved = [];
        // Receive distributions first since these may cause arrival of more contextAwareness blocks.
        // TODO: this closure algorithm is not reliable since we only get one shot at a "function" grade source when
        // really we should perform complete closure over all other sources of options before we try it at the very end - particularly important for contextAwareness
        var distributedBlocks = fluid.receiveDistributions(null, null, null, that);
        if (distributedBlocks.length > 0) {
            var readyBlocks = fluid.applyDistributions(that, distributedBlocks, shadow);
            // rely on the fact that "dirty tricks are not permitted" wrt. resolving gradeNames - each element must be a literal entry or array
            // holding primitive or EL values - otherwise we would have to go all round the houses and reenter the top of fluid.computeDynamicGrades
            var gradeNamesList = fluid.transform(fluid.getMembers(readyBlocks, ["source", "gradeNames"]), fluid.makeArray);
            resolved = resolved.concat.apply(resolved, gradeNamesList);
        }
        fluid.each(dynamicGrades, function (dynamicGrade) {
            var expanded = fluid.expandOptions(dynamicGrade, that);
            if (typeof(expanded) === "function") {
                expanded = expanded();
            }
            if (expanded) {
                resolved = resolved.concat(expanded);
            }
        });
        return resolved;
    };

    // Discover further grades that are entailed by the given base typeName and the current total "dynamic grades list" held in the argument "resolved".
    // These are looked up conjointly in the grade registry, and then any further dynamic grades references  
    // are expanded and added into the list and concatenated into "resolved". Additional grades discovered during this function are returned as
    // "furtherResolved".
    fluid.collectDynamicGrades = function (that, shadow, defaultsBlock, gradeNames, dynamicGrades, resolved) {
        var newDefaults = fluid.copy(fluid.getGradedDefaults(that.typeName, resolved));
        gradeNames.length = 0; // acquire derivatives of dynamic grades (FLUID-5054)
        gradeNames.push.apply(gradeNames, newDefaults.gradeNames);

        fluid.cacheShadowGrades(that, shadow);
        // This cheap strategy patches FLUID-5091 for now - some more sophisticated activity will take place
        // at this site when we have a full fix for FLUID-5028
        shadow.mergeOptions.destroyValue(["mergePolicy"]);
        shadow.mergeOptions.destroyValue(["components"]);
        shadow.mergeOptions.destroyValue(["invokers"]);

        defaultsBlock.source = newDefaults;
        shadow.mergeOptions.updateBlocks();

        var furtherResolved = fluid.remove_if(gradeNames, function (gradeName) {
            return gradeName.charAt(0) === "{" && !fluid.contains(dynamicGrades, gradeName);
        }, []);
        dynamicGrades.push.apply(dynamicGrades, furtherResolved);
        furtherResolved = fluid.expandDynamicGrades(that, shadow, gradeNames, furtherResolved);

        resolved.push.apply(resolved, furtherResolved);

        return furtherResolved;
    };

    fluid.computeDynamicGrades = function (that, shadow, strategy) {
        delete that.options.gradeNames; // Recompute gradeNames for FLUID-5012 and others

        var gradeNames = fluid.driveStrategy(that.options, "gradeNames", strategy);
        // TODO: In complex distribution cases, a component might end up with multiple default blocks
        var defaultsBlock = fluid.findMergeBlocks(shadow.mergeOptions.mergeBlocks, "defaults")[0];
        var dynamicGrades = fluid.remove_if(gradeNames, function (gradeName) {
            return gradeName.charAt(0) === "{" || !fluid.hasGrade(defaultsBlock.target, gradeName);
        }, []);
        var resolved = fluid.expandDynamicGrades(that, shadow, gradeNames, dynamicGrades);
        if (resolved.length !== 0) {
            var furtherResolved;
            do { // repeatedly collect dynamic grades whilst they arrive (FLUID-5155)
                furtherResolved = fluid.collectDynamicGrades(that, shadow, defaultsBlock, gradeNames, dynamicGrades, resolved);
            }
            while (furtherResolved.length !== 0);
        }
        if (shadow.collectedClearer) {
            shadow.collectedClearer();
            delete shadow.collectedClearer;
        }
    };

    fluid.computeDynamicComponentKey = function (recordKey, sourceKey) {
        return recordKey + (sourceKey === 0 ? "" : "-" + sourceKey); // TODO: configurable name strategies
    };

    fluid.registerDynamicRecord = function (that, recordKey, sourceKey, record, toCensor) {
        var key = fluid.computeDynamicComponentKey(recordKey, sourceKey);
        var cRecord = fluid.copy(record);
        delete cRecord[toCensor];
        fluid.set(that.options, ["components", key], cRecord);
        return key;
    };

    fluid.computeDynamicComponents = function (that, mergeOptions) {
        var shadow = fluid.shadowForComponent(that);
        var localSub = shadow.subcomponentLocal = {};
        var records = fluid.driveStrategy(that.options, "dynamicComponents", mergeOptions.strategy);
        fluid.each(records, function (record, recordKey) {
            if (!record.sources && !record.createOnEvent) {
                fluid.fail("Cannot process dynamicComponents record ", record, " without a \"sources\" or \"createOnEvent\" entry");
            }
            if (record.sources) {
                var sources = fluid.expandOptions(record.sources, that);
                fluid.each(sources, function (source, sourceKey) {
                    var key = fluid.registerDynamicRecord(that, recordKey, sourceKey, record, "sources");
                    localSub[key] = {"source": source, "sourcePath": sourceKey};
                });
            }
            else if (record.createOnEvent) {
                var event = fluid.event.expandOneEvent(that, record.createOnEvent);
                fluid.set(shadow, ["dynamicComponentCount", recordKey], 0);
                var listener = function () {
                    var key = fluid.registerDynamicRecord(that, recordKey, shadow.dynamicComponentCount[recordKey]++, record, "createOnEvent");
                    localSub[key] = {"arguments": fluid.makeArray(arguments)};
                    fluid.initDependent(that, key);
                };
                event.addListener(listener);
                fluid.recordListener(event, listener, shadow);
            }
        });
    };

    // Second sequence point for mergeOptions from Fluid.js - here we construct all further
    // strategies required on the IoC side and mount them into the shadow's getConfig for universal use
    fluid.computeComponentAccessor = function (that) {
        var instantiator = fluid.globalInstantiator;
        var shadow = fluid.shadowForComponent(that);
        var options = that.options;
        var strategy = shadow.mergeOptions.strategy;
        var optionsStrategy = fluid.mountStrategy(["options"], options, strategy);
        shadow.invokerStrategy = fluid.recordStrategy(that, options, strategy, "invokers", fluid.invokerFromRecord);
        shadow.eventStrategyBlock = fluid.recordStrategy(that, options, strategy, "events", fluid.eventFromRecord, ["events"]);
        var eventStrategy = fluid.mountStrategy(["events"], that, shadow.eventStrategyBlock.strategy, ["events"]);
        shadow.memberStrategy = fluid.recordStrategy(that, options, strategy, "members", fluid.memberFromRecord);
        // NB - ginger strategy handles concrete, rationalise
        shadow.getConfig = {strategies: [fluid.model.funcResolverStrategy, fluid.makeGingerStrategy(that),
            optionsStrategy, shadow.invokerStrategy.strategy, shadow.memberStrategy.strategy, eventStrategy]};

        fluid.computeDynamicGrades(that, shadow, strategy, shadow.mergeOptions.mergeBlocks);
        fluid.distributeOptions(that, strategy);
        if (shadow.contextHash["fluid.resolveRoot"]) {
            var memberName;
            if (shadow.contextHash["fluid.resolveRootSingle"]) {
                var singleRootType = fluid.getForComponent(that, ["options", "singleRootType"]);
                if (!singleRootType) {
                    fluid.fail("Cannot register object with grades " + Object.keys(shadow.contextHash).join(", ") + " as fluid.resolveRootSingle since it has not defined option singleRootType");
                }
                memberName = fluid.typeNameToMemberName(singleRootType);
            } else {
                memberName = fluid.computeGlobalMemberName(that);
            }
            var parent = fluid.resolveRootComponent;
            if (parent[memberName]) {
                instantiator.clearComponent(parent, memberName);
            }
            instantiator.recordKnownComponent(parent, that, memberName, false);
        }

        return shadow.getConfig;
    };

    // About the SHADOW:
    // Allocated at: instantiator's "recordComponent"
    // Contents:
    //     path {String} Principal allocated path (point of construction) in tree
    //     that {Component} The component itself
    //     contextHash {String to Boolean} Map of context names which this component matches
    //     mergePolicy, mergeOptions: Machinery for last phase of options merging
    //     invokerStrategy, eventStrategyBlock, memberStrategy, getConfig: Junk required to operate the accessor
    //     listeners: Listeners registered during this component's construction, to be cleared during clearListeners
    //     distributions, collectedClearer: Managing options distributions
    //     subcomponentLocal: Signalling local record from computeDynamicComponents to assembleCreatorArguments
    
    fluid.shadowForComponent = function (component) {
        var instantiator = fluid.getInstantiator(component);
        return instantiator && component ? instantiator.idToShadow[component.id] : null;
    };

    // Access the member at a particular path in a component, forcing it to be constructed gingerly if necessary
    // supported, PUBLIC API function 
    fluid.getForComponent = function (component, path) {
        var shadow = fluid.shadowForComponent(component);
        var getConfig = shadow ? shadow.getConfig : undefined;
        return fluid.get(component, path, getConfig);
    };

    // An EL segment resolver strategy that will attempt to trigger creation of
    // components that it discovers along the EL path, if they have been defined but not yet
    // constructed.
    fluid.makeGingerStrategy = function (that) {
        var instantiator = fluid.getInstantiator(that);
        return function (component, thisSeg, index, segs) {
            var atval = component[thisSeg];
            if (atval === fluid.inEvaluationMarker && index === segs.length) {
                fluid.fail("Error in component configuration - a circular reference was found during evaluation of path segment \"" + thisSeg +
                    "\": for more details, see the activity records following this message in the console, or issue fluid.setLogging(fluid.logLevel.TRACE) when running your application");
            }
            if (index > 1) {
                return atval;
            }
            if (atval === undefined && component.hasOwnProperty(thisSeg)) { // avoid recomputing properties that have been explicitly evaluated to undefined
                return fluid.NO_VALUE;
            }
            if (atval === undefined) { // pick up components in instantiation here - we can cut this branch by attaching early
                var parentPath = instantiator.idToShadow[component.id].path;
                var childPath = instantiator.composePath(parentPath, thisSeg);
                atval = instantiator.pathToComponent[childPath];
            }
            if (atval === undefined) {
                // TODO: This check is very expensive - once gingerness is stable, we ought to be able to
                // eagerly compute and cache the value of options.components - check is also incorrect and will miss injections
                var subRecord = fluid.getForComponent(component, ["options", "components", thisSeg]);
                if (subRecord) {
                    if (subRecord.createOnEvent) {
                        fluid.fail("Error resolving path segment \"" + thisSeg + "\" of path " + segs.join(".") + " since component with record ", subRecord,
                            " has annotation \"createOnEvent\" - this very likely represents an implementation error. Either alter the reference so it does not " +
                            " match this component, or alter your workflow to ensure that the component is instantiated by the time this reference resolves");
                    }
                    fluid.initDependent(component, thisSeg);
                    atval = component[thisSeg];
                }
            }
            return atval;
        };
    };
    
    // Listed in dependence order
    fluid.frameworkGrades = ["fluid.littleComponent", "fluid.eventedComponent",
        "fluid.commonModelComponent", "fluid.commonViewComponent", "fluid.commonRendererComponent",
        "fluid.modelComponent", "fluid.viewComponent", "fluid.standardComponent", "fluid.rendererComponent",
        "fluid.modelComponent", "fluid.viewComponent", "fluid.standardComponent", "fluid.rendererComponent"];
    
        
    fluid.filterBuiltinGrades = function (gradeNames) {
        return fluid.remove_if(fluid.makeArray(gradeNames), function (gradeName) {
            return fluid.frameworkGrades.indexOf(gradeName) !== -1;
        });
    };

    fluid.dumpGradeNames = function (that) {
        return that.options && that.options.gradeNames ?
            " gradeNames: " + JSON.stringify(fluid.filterBuiltinGrades(that.options.gradeNames)) : "";
    };

    fluid.dumpThat = function (that) {
        return "{ typeName: \"" + that.typeName + "\"" + fluid.dumpGradeNames(that) + " id: " + that.id + "}";
    };

    fluid.dumpThatStack = function (thatStack, instantiator) {
        var togo = fluid.transform(thatStack, function(that) {
            var path = instantiator.idToPath(that.id);
            return fluid.dumpThat(that) + (path? (" - path: " + path) : "");
        });
        return togo.join("\n");
    };

    fluid.resolveContext = function (context, that) {
        var instantiator = fluid.getInstantiator(that);
        if (context === "instantiator") {
            return instantiator;
        }
        else if (context === "that") {
            return that;
        }
        var foundComponent;
        var thatStack = instantiator.getFullStack(that);
        fluid.visitComponentsForVisibility(instantiator, thatStack, function (component, name) {
            var shadow = fluid.shadowForComponent(component);
            // TODO: Some components, e.g. the static environment and typeTags do not have a shadow, which slows us down here
            if (context === name || shadow && shadow.contextHash && shadow.contextHash[context] || context === component.typeName || context === component.nickName) {
                foundComponent = component;
                return true; // YOUR VISIT IS AT AN END!!
            }
            if (fluid.getForComponent(component, ["options", "components", context, "type"]) && !component[context]) {
  // This is an expensive guess since we make it for every component up the stack - must apply the WAVE OF EXPLOSIONS (FLUID-4925) to discover all components first
  // This line attempts a hopeful construction of components that could be guessed by nickname through finding them unconstructed
  // in options. In the near future we should eagerly BEGIN the process of constructing components, discovering their
  // types and then attaching them to the tree VERY EARLY so that we get consistent results from different strategies.
                foundComponent = fluid.getForComponent(component, context);
                return true;
            }
        });
        return foundComponent;
    };

    var localRecordExpected = /^(arguments|options|container|source|sourcePath|change)$/;

    fluid.makeStackFetcher = function (parentThat, localRecord) {
        var fetcher = function (parsed) {
            if (parentThat && parentThat.destroy === fluid.destroyedMarker) {
                fluid.fail("Cannot resolve reference " + fluid.renderContextReference(parsed) + " from component " + fluid.dumpThat(parentThat) + " which has been destroyed");
            }
            var context = parsed.context;
            if (localRecord && localRecordExpected.test(context)) {
                var fetched = fluid.get(localRecord[context], parsed.path);
                return context === "arguments" || context === "source" || context === "sourcePath" || context === "change" ? fetched : {
                    marker: context === "options" ? fluid.EXPAND : fluid.EXPAND_NOW,
                    value: fetched
                };
            }
            var foundComponent = fluid.resolveContext(context, parentThat);
            if (!foundComponent && parsed.path !== "") {
                var ref = fluid.renderContextReference(parsed);
                fluid.fail("Failed to resolve reference " + ref + " - could not match context with name " +
                    context + " from component " + fluid.dumpThat(parentThat), parentThat);
            }
            return fluid.getForComponent(foundComponent, parsed.path);
        };
        return fetcher;
    };

    fluid.makeStackResolverOptions = function (parentThat, localRecord) {
        return $.extend(fluid.copy(fluid.rawDefaults("fluid.makeExpandOptions")), {
            fetcher: fluid.makeStackFetcher(parentThat, localRecord),
            contextThat: parentThat
        });
    };

    fluid.clearListeners = function (shadow) {
        // TODO: bug here - "afterDestroy" listeners will be unregistered already unless they come from this component
        fluid.each(shadow.listeners, function (rec) {
            rec.event.removeListener(rec.listener);
        });
        delete shadow.listeners;
    };

    fluid.recordListener = function (event, listener, shadow) {
        if (event.ownerId !== shadow.that.id) { // don't bother recording listeners registered from this component itself
            var listeners = shadow.listeners;
            if (!listeners) {
                listeners = shadow.listeners = [];
            }
            listeners.push({event: event, listener: listener});
        }
    };

    // unsupported, non-API function - however, this structure is of considerable interest to those debugging
    // into IoC issues. The structures idToShadow and pathToComponent contain a complete map of the component tree
    // forming the surrounding scope
    fluid.instantiator = function () {
        var that = {
            id: fluid.allocateGuid(),
            nickName: "instantiator",
            pathToComponent: {},
            idToShadow: {},
            modelTransactions: {init: {}}, // a map of transaction id to map of component id to records of components enlisted in a current model initialisation transaction
            composePath: fluid.model.composePath, // For speed, we declare that no component's name may contain a period
            composeSegments: fluid.model.composeSegments,
            parseEL: fluid.model.parseEL,
            events: {
                onComponentAttach: fluid.makeEventFirer({name: "instantiator's onComponentAttach event"}),
                onComponentClear: fluid.makeEventFirer({name: "instantiator's onComponentClear event"})
            }
        };
        // We frequently get requests for components not in this instantiator - e.g. from the dynamicEnvironment or manually created ones
        that.idToPath = function (id) {
            var shadow = that.idToShadow[id];
            return shadow ? shadow.path : "";
        };
        // Note - the returned stack is assumed writeable and does not include the root
        that.getThatStack = function (component) {
            var shadow = that.idToShadow[component.id];
            if (shadow) {
                var path = shadow.path;
                var parsed = fluid.model.parseEL(path);
                var root = that.pathToComponent[""], togo = [];
                for (var i = 0; i < parsed.length; ++ i) {
                    root = root[parsed[i]];
                    togo.push(root);
                }
                return togo;
            }
            else { return [];}
        };
        that.getFullStack = function (component) {
            var thatStack = component? that.getThatStack(component) : [];
            thatStack.unshift(fluid.globalThreadLocal());
            thatStack.unshift(fluid.resolveRootComponent);
            return thatStack;
        };
        function recordComponent(component, path, created) {
            var shadow;
            if (created) {
                shadow = that.idToShadow[component.id] = {};
                shadow.that = component;
                shadow.path = path;
            } else {
                shadow = that.idToShadow[component.id];
                shadow.injectedPaths = shadow.injectedPaths || [];
                shadow.injectedPaths.push(path);
            }
            if (that.pathToComponent[path]) {
                fluid.fail("Error during instantiation - path " + path + " which has just created component " + fluid.dumpThat(component) +
                    " has already been used for component " + fluid.dumpThat(that.pathToComponent[path]) + " - this is a circular instantiation or other oversight." +
                    " Please clear the component using instantiator.clearComponent() before reusing the path.");
            }
            that.pathToComponent[path] = component;
        }
        that.recordRoot = function (component) {
            recordComponent(component, "", true);
        };
        that.recordKnownComponent = function (parent, component, name, created) {
            parent[name] = component;
            if (fluid.isComponent(component)) {
                var parentPath = that.idToShadow[parent.id].path;
                var path = that.composePath(parentPath, name);
                recordComponent(component, path, created);
                that.events.onComponentAttach.fire(component, path, that, created);
            }
        };
        that.clearComponent = function (component, name, child, options, noModTree, path) {
            // options are visitor options for recursive driving
            var record = that.idToShadow[component.id].path;
            // use flat recursion since we want to use our own recursion rather than rely on "visited" records
            options = options || {flat: true, instantiator: that};
            child = child || component[name];
            path = path || record;
            if (path === undefined) {
                fluid.fail("Cannot clear component " + name + " from component ", component,
                    " which was not created by this instantiator");
            }

            var childPath = that.composePath(path, name);
            var childShadow = that.idToShadow[child.id];
            var created = childShadow.path === childPath;
            that.events.onComponentClear.fire(child, childPath, component, created);

            // only recurse on components which were created in place - if the id record disagrees with the
            // recurse path, it must have been injected
            if (created) {
                // Clear injected instance of this component from all other paths - historically we didn't bother
                // to do this since injecting into a shorter scope is an error - but now we have resolveRoot area
                fluid.each(childShadow.injectedPaths, function (injectedPath) {
                    var parentPath = fluid.model.getToTailPath(injectedPath);
                    var otherParent = that.pathToComponent[parentPath];
                    that.clearComponent(otherParent, fluid.model.getTailPath(injectedPath), child);
                });
                fluid.doDestroy(child, name, component);
                fluid.clearDistributions(childShadow);
                fluid.clearListeners(childShadow);
                fluid.visitComponentChildren(child, function(gchild, gchildname, segs, i) {
                    var parentPath = that.composeSegments.apply(null, segs.slice(0, i));
                    that.clearComponent(child, gchildname, null, options, true, parentPath);
                }, options, that.parseEL(childPath));
                fluid.fireEvent(child, "events.afterDestroy", [child, name, component]);
                delete that.idToShadow[child.id];
            }
            delete that.pathToComponent[childPath]; // there may be no entry - if created informally
            if (!noModTree) {
                delete component[name]; // there may be no entry - if creation is not concluded
            }
        };
        return that;
    };

    // The global instantiator, holding all components instantiated in this context (instance of Infusion)
    fluid.globalInstantiator = fluid.instantiator();
    
    // Look up the globally registered instantiator for a particular component - we now only really support a
    // single, global instantiator, but this method is left as a notation point in case this ever reverts
    fluid.getInstantiator = function (component) {
        var instantiator = fluid.globalInstantiator;
        return component && instantiator.idToShadow[component.id] ? instantiator : null;
    };
    
    // The grade supplied to components which will be resolvable from all parts of the component tree
    fluid.defaults("fluid.resolveRoot");
    // In addition to being resolvable at the root, "resolveRootSingle" component will have just a single instance available. Fresh
    // instances will displace older ones.
    fluid.defaults("fluid.resolveRootSingle", {
        gradeNames: "fluid.resolveRoot"
    });
    
    // Instantiate the primordial components at the root of each context tree
    
    fluid.rootComponent = fluid.typeTag("fluid.rootComponent");
   
    fluid.globalInstantiator.recordRoot(fluid.rootComponent);
    
    // if we ever support more than one thread, fix this
    fluid.globalInstantiator.recordKnownComponent(fluid.rootComponent, fluid.dynamicEnvironment, "dynamicEnvironment", true);
    // The component which for convenience holds injected instances of all components with fluid.resolveRoot grade
    fluid.resolveRootComponent = fluid.typeTag("fluid.resolveRootComponent");
    fluid.globalInstantiator.recordKnownComponent(fluid.rootComponent, fluid.resolveRootComponent, "resolveRootComponent", true);
    fluid.globalInstantiator.recordKnownComponent(fluid.resolveRootComponent, fluid.globalInstantiator, "instantiator", false);

    /** Expand a set of component options either immediately, or with deferred effect.
     *  The current policy is to expand immediately function arguments within fluid.assembleCreatorArguments which are not the main options of a
     *  component. The component's own options take <code>{defer: true}</code> as part of
     *  <code>outerExpandOptions</code> which produces an "expandOptions" structure holding the "strategy" and "initter" pattern
     *  common to ginger participants.
     *  Probably not to be advertised as part of a public API, but is considerably more stable than most of the rest
     *  of the IoC API structure especially with respect to the first arguments.
     */

// TODO: Can we move outerExpandOptions to 2nd place? only user of 3 and 4 is fluid.makeExpandBlock
    fluid.expandOptions = function (args, that, mergePolicy, localRecord, outerExpandOptions) {
        if (!args) {
            return args;
        }
        fluid.pushActivity("expandOptions", "expanding options %args for component %that ", {that: that, args: args});
        var expandOptions = fluid.makeStackResolverOptions(that, localRecord);
        expandOptions.mergePolicy = mergePolicy;
        // TODO: "freeRoot" used only in fluid.memberFromRecord - purpose has been forgotten
        expandOptions.freeRoot = outerExpandOptions && outerExpandOptions.freeRoot;
        var expanded = outerExpandOptions && outerExpandOptions.defer ?
            fluid.makeExpandOptions(args, expandOptions) : fluid.expand(args, expandOptions);
        fluid.popActivity();
        return expanded;
    };

    fluid.localRecordExpected = ["type", "options", "args", "mergeOptions", "createOnEvent", "priority", "recordType"]; // last element unavoidably polluting

    fluid.checkComponentRecord = function (defaults, localRecord) {
        var expected = fluid.arrayToHash(fluid.localRecordExpected);
        fluid.each(defaults && defaults.argumentMap, function(value, key) {
            expected[key] = true;
        });
        fluid.each(localRecord, function (value, key) {
            if (!expected[key]) {
                fluid.fail("Probable error in subcomponent record ", localRecord, " - key \"" + key +
                    "\" found, where the only legal options are " +
                    fluid.keys(expected).join(", "));
            }
        });
    };

    fluid.mergeRecordsToList = function (mergeRecords) {
        var list = [];
        fluid.each(mergeRecords, function (value, key) {
            value.recordType = key;
            if (key === "distributions") {
                list.push.apply(list, value);
            }
            else {
                if (!value.options) { return; }
                value.priority = fluid.mergeRecordTypes[key];
                if (value.priority === undefined) {
                    fluid.fail("Merge record with unrecognised type " + key + ": ", value);
                }
                list.push(value);
            }
        });
        return list;
    };

    // TODO: overall efficiency could huge be improved by resorting to the hated PROTOTYPALISM as an optimisation
    // for this mergePolicy which occurs in every component. Although it is a deep structure, the root keys are all we need
    var addPolicyBuiltins = function (policy) {
        fluid.each(["gradeNames", "mergePolicy", "argumentMap", "components", "dynamicComponents", "members", "invokers", "events", "listeners", "modelListeners", "distributeOptions", "transformOptions"], function (key) {
            fluid.set(policy, [key, "*", "noexpand"], true);
        });
        return policy;
    };

    // used from Fluid.js
    fluid.generateExpandBlock = function (record, that, mergePolicy, localRecord) {
        var expanded = fluid.expandOptions(record.options, record.contextThat || that, mergePolicy, localRecord, {defer: true});
        expanded.priority = record.priority;
        expanded.recordType = record.recordType;
        return expanded;
    };

    var expandComponentOptionsImpl = function (mergePolicy, defaults, initRecord, that) {
        var defaultCopy = fluid.copy(defaults);
        addPolicyBuiltins(mergePolicy);
        var shadow = fluid.shadowForComponent(that);
        shadow.mergePolicy = mergePolicy;
        var mergeRecords = {
            defaults: {options: defaultCopy}
        };

        $.extend(mergeRecords, initRecord.mergeRecords);
        // Do this here for gradeless components that were corrected by "localOptions"
        if (mergeRecords.subcomponentRecord) {
            fluid.checkComponentRecord(defaults, mergeRecords.subcomponentRecord);
        }
        
        var expandList = fluid.mergeRecordsToList(mergeRecords);

        var togo = fluid.transform(expandList, function (value) {
            return fluid.generateExpandBlock(value, that, mergePolicy, initRecord.localRecord);
        });
        return togo;
    };
    
    fluid.fabricateDestroyMethod = function (that, name, instantiator, child) {
        return function () {
            instantiator.clearComponent(that, name, child);
        };
    };
    
    // Computes a name for a component appearing at the global root which is globally unique, from its nickName and id
    fluid.computeGlobalMemberName = function (that) {
        var nickName = fluid.computeNickName(that.typeName);
        return nickName + "-" + that.id;
    };
    
    // Maps a type name to the member name to be used for it at a particular path level where it is intended to be unique
    // Note that "." is still not supported within a member name
    // unsupported, NON-API function
    fluid.typeNameToMemberName = function (typeName) {
        return typeName.replace(/\./g, "_");
    };

    // This is the initial entry point from the non-IoC side reporting the first presence of a new component - called from fluid.mergeComponentOptions
    fluid.expandComponentOptions = function (mergePolicy, defaults, userOptions, that) {
        var initRecord = userOptions; // might have been tunnelled through "userOptions" from "assembleCreatorArguments"
        var instantiator = userOptions && userOptions.marker === fluid.EXPAND ? userOptions.instantiator : null;
        if (!instantiator) { // it is a top-level component which needs to be attached to the global root
            instantiator = fluid.globalInstantiator;
            initRecord = { // upgrade "userOptions" to the same format produced by fluid.assembleCreatorArguments via the subcomponent route
                mergeRecords: {user: {options: fluid.expandCompact(userOptions, true)}},
                memberName: fluid.computeGlobalMemberName(that),
                instantiator: instantiator,
                parentThat: fluid.rootComponent
            };
        }
        that.destroy = fluid.fabricateDestroyMethod(initRecord.parentThat, initRecord.memberName, instantiator, that);
        fluid.pushActivity("expandComponentOptions", "expanding component options %options with record %record for component %that",
            {options: fluid.get(initRecord.mergeRecords, "user.options"), record: initRecord, that: that});
            
        instantiator.recordKnownComponent(initRecord.parentThat, that, initRecord.memberName, true);
        var togo = expandComponentOptionsImpl(mergePolicy, defaults, initRecord, that);
        
        fluid.popActivity();
        return togo;
    };

    fluid.argMapToSpec = function (argMap) {
        var togo = [];
        fluid.each(argMap, function (value, key) {
            togo[value] = "{" + key + "}";
        });
        return togo;
    };

    /** Given a typeName, determine the final concrete
     * "invocation specification" consisting of a concrete global function name
     * and argument list which is suitable to be executed directly by fluid.invokeGlobalFunction.
     */
    // options is just a disposition record containing memberName, componentRecord
    fluid.assembleCreatorArguments = function (parentThat, typeName, options) {
        var upDefaults = fluid.defaults(typeName);
        if (!upDefaults || !upDefaults.argumentMap) {
            fluid.fail("Error in assembleCreatorArguments: cannot look up component type name " + typeName + " to a component creator grade with an argumentMap");
        }

        var fakeThat = {}; // fake "that" for receiveDistributions since we try to match selectors before creation for FLUID-5013
        var distributions = parentThat ? fluid.receiveDistributions(parentThat, upDefaults.gradeNames, options.memberName, fakeThat) : [];

        var argMap = upDefaults.argumentMap;
        var argSpec = fluid.argMapToSpec(argMap);
        
        var shadow = fluid.shadowForComponent(parentThat);
        var localDynamic = shadow && shadow.subcomponentLocal && options.memberName ? shadow.subcomponentLocal[options.memberName] : null;

        var localRecord = $.extend({}, fluid.censorKeys(options.componentRecord, ["type"]), localDynamic);

        fluid.each(argMap, function (index, name) {
            if (name !== "options") {
                for (var i = 0; i < distributions.length; ++ i) { // Apply non-options material from distributions (FLUID-5013)
                    if (distributions[i][name] !== undefined) {
                        localRecord[name] = distributions[i][name];
                    }
                }
            }
        });
        var i;
        for (i = 0; i < distributions.length; ++ i) {
            if (distributions[i].type !== undefined) {
                typeName = distributions[i].type;
            }
        }

        var mergeRecords = {distributions: distributions};

        if (options.componentRecord !== undefined) {
            // Deliberately put too many things here so they can be checked in expandComponentOptions (FLUID-4285)
            mergeRecords.subcomponentRecord = $.extend({}, options.componentRecord);
        }
        var expandOptions = fluid.makeStackResolverOptions(parentThat, localRecord);

        var args = [];
        for (i = 0; i < argSpec.length; ++i) {
            var arg = argSpec[i];
            if (argMap.options !== i) {
                // expand immediately if this is not the options
                args[i] = fluid.expand(arg, expandOptions);
            }
            else { // It is the component options
                args[i] = {marker: fluid.EXPAND,
                           localRecord: localDynamic,
                           mergeRecords: mergeRecords,
                           instantiator: fluid.getInstantiator(parentThat),
                           parentThat: parentThat,
                           memberName: options.memberName};
            }
            if (args[i] && fluid.isMarker(args[i].marker, fluid.EXPAND_NOW)) {
                args[i] = fluid.expand(args[i].value, expandOptions);
            }
        }

        var togo = {
            args: args,
            funcName: typeName
        };
        return togo;
    };

    /** Instantiate the subcomponent with the supplied name of the supplied top-level component. Although this method
     * is published as part of the Fluid API, it should not be called by general users and may not remain stable. It is
     * currently the only mechanism provided for instantiating components whose definitions are dynamic, and will be
     * replaced in time by dedicated declarative framework described by FLUID-5022.
     * @param that {Component} the parent component for which the subcomponent is to be instantiated
     * @param name {String} the name of the component - the index of the options block which configures it as part of the
     * <code>components</code> section of its parent's options
     */
    fluid.initDependent = function (that, name) {
        if (that[name]) { return; } // TODO: move this into strategy
        var component = that.options.components[name];
        fluid.pushActivity("initDependent", "instantiating dependent component with name \"%name\" with record %record as child of %parent",
            {name: name, record: component, parent: that});
        var instance;
        var instantiator = fluid.globalInstantiator;

        if (typeof(component) === "string") {
            instance = fluid.expandOptions(component, that);
            instantiator.recordKnownComponent(that, instance, name, false);
        }
        else if (component.type) {
            var type = fluid.expandOptions(component.type, that);
            if (!type) {
                fluid.fail("Error in subcomponent record: ", component.type, " could not be resolved to a type for component ", name,
                    " of parent ", that);
            }
            var invokeSpec = fluid.assembleCreatorArguments(that, type, {componentRecord: component, memberName: name});
            instance = fluid.initSubcomponentImpl(that, {type: invokeSpec.funcName}, invokeSpec.args);
            // The existing instantiator record will be provisional, adjust it to take account of the true return
            // TODO: This entire workflow will shortly be removed - we can't tolerate components constructed out of place
            var path = instantiator.composePath(instantiator.idToPath(that.id), name);
            var existing = instantiator.pathToComponent[path];
            // This branch deals with the case where the component creator registered a component into "pathToComponent"
            // that does not agree with the component which was the return value. We need to clear out "pathToComponent" but
            // not shred the component since most of it is probably still valid
            if (existing && existing !== instance) {
                instantiator.clearComponent(that, name, existing);
            }
            if (instance && instance.typeName && instance.id && instance !== existing) {
                instantiator.recordKnownComponent(that, instance, name, true);
            }
        }
        else {
            fluid.fail("Unrecognised material in place of subcomponent " + name + " - no \"type\" field found");
        }
        fluid.popActivity();
        return instance;
    };

    fluid.bindDeferredComponent = function (that, componentName, component) {
        var events = fluid.makeArray(component.createOnEvent);
        fluid.each(events, function(eventName) {
            var event = eventName.charAt(0) === "{" ? fluid.expandOptions(eventName, that) : that.events[eventName];
            if (!event || !event.addListener) {
                fluid.fail("Error instantiating createOnEvent component with name " + componentName + " of parent ", that, " since event specification " +
                    eventName + " could not be expanded to an event - got ", event);
            }
            event.addListener(function () {
                fluid.pushActivity("initDeferred", "instantiating deferred component %componentName of parent %that due to event %eventName",
                 {componentName: componentName, that: that, eventName: eventName});
                if (that[componentName]) {
                    fluid.globalInstantiator.clearComponent(that, componentName);
                }
                fluid.initDependent(that, componentName);
                fluid.popActivity();
            }, null, null, component.priority);
        });
    };

    fluid.priorityForComponent = function (component) {
        return component.priority? component.priority :
            (component.type === "fluid.typeFount" || fluid.hasGrade(fluid.defaults(component.type), "fluid.typeFount"))?
            "first" : undefined;
    };

    fluid.initDependents = function (that) {
        fluid.pushActivity("initDependents", "instantiating dependent components for component %that", {that: that});
        var shadow = fluid.shadowForComponent(that);
        shadow.memberStrategy.initter();

        var options = that.options;
        var components = options.components || {};
        var componentSort = [];

        fluid.each(components, function (component, name) {
            if (!component.createOnEvent) {
                var priority = fluid.priorityForComponent(component);
                componentSort.push({namespace: name, priority: fluid.parsePriority(priority)});
            }
            else {
                fluid.bindDeferredComponent(that, name, component);
            }
        });
        fluid.sortByPriority(componentSort);
        fluid.each(componentSort, function (entry) {
            fluid.initDependent(that, entry.namespace);
        });

        shadow.invokerStrategy.initter();
        fluid.popActivity();
    };

    
    /** BEGIN NEXUS METHODS **/
    
    /** Construct a component with the supplied options at the specified path in the component tree. The parent path of the location must already be a component.
     * @param path {String|Array of String} Path where the new component is to be constructed, represented as a string or array of segments
     * @param typeName {String} The principal type of the component (name of its creator function)
     * @param options {Object} [optional] Options supplied to the component
     * @param instantiator {Instantiator} [optional] The instantiator holding the component to be created - if blank, the global instantiator will be used
     */
    fluid.construct = function (path, options, instantiator) {
        var record = fluid.destroy(path, instantiator);
        // TODO: We must construct a more principled scheme for designating child components than this - especially once options become immutable
        fluid.set(record.parent, ["options", "components", record.memberName], {
            type: options.type,
            options: options
        });
        return fluid.initDependent(record.parent, record.memberName);
    };

    /** Destroys a component held at the specified path. The parent path must represent a component, although the component itself may be nonexistent
     * @param path {String|Array of String} Path where the new component is to be destroyed, represented as a string or array of segments
     * @param instantiator {Instantiator} [optional] The instantiator holding the component to be destroyed - if blank, the global instantiator will be used
     */
    fluid.destroy = function (path, instantiator) {
        instantiator = instantiator || fluid.globalInstantiator;
        var segs = fluid.model.parseToSegments(path, instantiator.parseEL, true);
        if (segs.length === 0) {
            fluid.fail("Cannot destroy the root component");
        }
        var memberName = segs.pop(), parentPath = instantiator.composeSegments.apply(null, segs);
        var parent = instantiator.pathToComponent[parentPath];
        if (!parent) {
            fluid.fail("Cannot modify component with nonexistent parent at path ", path);
        }
        if (parent[memberName]) {
            parent[memberName].destroy();
        }
        return {
            parent: parent,
            memberName: memberName
        };
    };
    
    /** END NEXUS METHODS **/
    
    /** BEGIN IOC DEBUGGING METHODS **/
    fluid["debugger"] = function () {
        /* jshint ignore:start */
        debugger;
        /* jshint ignore:end */
    };
    
    fluid.defaults("fluid.debuggingProbe", {
        gradeNames: ["fluid.littleComponent", "autoInit"]
    });
    
    // probe looks like:
    // target: {preview other}.listeners.eventName
    // priority: first/last
    // func: console.log/fluid.log/fluid.debugger
    fluid.probeToDistribution = function (probe) {
        var instantiator = fluid.globalInstantiator;
        var parsed = fluid.parseContextReference(probe.target);
        var segs = fluid.model.parseToSegments(parsed.path, instantiator.parseEL, true);
        if (segs[0] !== "options") {
            segs.unshift("options"); // compensate for this insanity until we have the great options flattening
        }
        var parsedPriority = fluid.parsePriority(probe.priority);
        if (parsedPriority.constraint && !parsedPriority.constraint.target) {
            parsedPriority.constraint.target = "authoring";
        }
        return {
            target: "{/ " + parsed.context + "}." + instantiator.composeSegments.apply(null, segs),
            record: {
                func: probe.func,
                funcName: probe.funcName,
                args: probe.args,
                priority: fluid.renderPriority(parsedPriority)
            }
        };
    };
    
    fluid.registerProbes = function (probes) {
        var probeDistribution = fluid.transform(probes, fluid.probeToDistribution);
        var memberName = "fluid_debuggingProbe_" + fluid.allocateGuid();
        fluid.construct([memberName], {
            type: "fluid.debuggingProbe",
            distributeOptions: probeDistribution
        });
        return memberName;
    };
    
    fluid.deregisterProbes = function (probeName) {
        fluid.destroy([probeName]);
    };
    
    /** END IOC DEBUGGING METHODS **/

    fluid.thisistToApplicable = function (record, recthis, that) {
        return {
            apply: function (noThis, args) {
                // Resolve this material late, to deal with cases where the target has only just been brought into existence
                // (e.g. a jQuery target for rendered material) - TODO: Possibly implement cached versions of these as we might do for invokers
                var resolvedThis = fluid.expandOptions(recthis, that);
                if (typeof(resolvedThis) === "string") {
                    resolvedThis = fluid.getGlobalValue(resolvedThis);
                }
                if (!resolvedThis) {
                    fluid.fail("Could not resolve reference " + recthis + " to a value");
                }
                var resolvedFunc = resolvedThis[record.method];
                if (typeof(resolvedFunc) !== "function") {
                    fluid.fail("Object ", resolvedThis, " at reference " + recthis + " has no member named " + record.method + " which is a function ");
                }
                fluid.log("Applying arguments ", args, " to method " + record.method + " of instance ", resolvedThis);
                return resolvedFunc.apply(resolvedThis, args);
            }
        };
    };

    fluid.changeToApplicable = function (record, that) {
        return {
            apply: function (noThis, args) {
                var parsed = fluid.parseValidModelReference(that, "changePath listener record", record.changePath);
                var value = fluid.expandOptions(record.value, that, {}, {"arguments": args});
                fluid.fireSourcedChange(parsed.applier, parsed.path, value, record.source);
            }
        };
    };

    // Convert "exotic records" into an applicable form ("this/method" for FLUID-4878 or "changePath" for FLUID-3674)
    fluid.recordToApplicable = function (record, that) {
        if (record.changePath) {
            return fluid.changeToApplicable(record, that);
        }
        var recthis = record["this"];
        if (record.method ^ recthis) {
            fluid.fail("Record ", that, " must contain both entries \"method\" and \"this\" if it contains either");
        }
        return record.method ? fluid.thisistToApplicable(record, recthis, that) : null;
    };

    var argPrefix = "{arguments}.";

    fluid.parseInteger = function (string) {
        return isFinite(string) && ((string % 1) === 0) ? Number(string) : NaN;
    };

    fluid.makeFastInvoker = function (invokerec, invokeSpec, func) {
        var argMap;
        if (invokerec.args !== undefined) {
            argMap = {};
            for (var i = 0; i < invokerec.args.length; ++ i) {
                var value = invokerec.args[i];
                if (typeof(value) === "string") {
                    if (value.indexOf("}.model") !== -1) {
                        return {noFast: true};
                    }
                    if (value === "{arguments}") {
                        argMap[i] = "*";
                    } else if (value.indexOf(argPrefix) === 0) {
                        var argIndex = fluid.parseInteger(value.substring(argPrefix.length));
                        if (isNaN(argIndex)) {
                            return {noFast: true};
                        }
                        else {
                            argMap[i] = argIndex; // target arg pos = original arg pos
                        }
                    }
                }
            }
        }
        var outArgs = invokeSpec.args;
        var invoke = argMap ? function invoke(args) {
            for (var i in argMap) {
                outArgs[i] = argMap[i] === "*" ? args : args[argMap[i]];
            }
            return func.apply(null, outArgs);
        } : function invoke (args) {
            return func.apply(null, args);
        };
        return {
            invoke: invoke
        };
    };
    
    fluid.getGlobalValueNonComponent = function (funcName, context) {
        var defaults = fluid.defaults(funcName);
        if (defaults && fluid.hasGrade(defaults, "fluid.littleComponent")) {
            fluid.fail("Error in function specification - cannot invoke function " + funcName + " in the context of " + context + ": component creator functions can only be used as subcomponents");
        }
        return fluid.getGlobalValue(funcName);
    };

    fluid.makeInvoker = function (that, invokerec, name) {
        if (typeof(invokerec) === "string") {
            if (invokerec.charAt(0) === "{") { // shorthand case for direct function invokers (FLUID-4926)
                invokerec = {func: invokerec};
            } else {
                invokerec = {funcName: invokerec};
            }
        }
        if (invokerec.args !== undefined && !fluid.isArrayable(invokerec.args)) {
            invokerec.args = fluid.makeArray(invokerec.args);
        }
        var fastRec = {noFast: invokerec.dynamic};
        return function invokeInvoker () {
            if (fluid.defeatLogging === false) {
                fluid.pushActivity("invokeInvoker", "invoking invoker with name %name and record %record from component %that", {name: name, record: invokerec, that: that});
            }
            var togo;
            if (fastRec.invoke) {
                togo = fastRec.invoke(arguments);
            }
            else {
                var func = fluid.recordToApplicable(invokerec, that);
                var args = fluid.makeArray(arguments);
                var invokeSpec = fluid.expandOptions(invokerec, that, null, {"arguments": args});
                func = func || (invokeSpec.funcName? fluid.getGlobalValueNonComponent(invokeSpec.funcName, "an invoker") : invokeSpec.func);
                if (!func || !func.apply) {
                    fluid.fail("Error in invoker record: could not resolve members func, funcName or method to a function implementation - got " + func + " from ", invokerec);
                }
                if (fastRec.noFast !== true) {
                    fastRec = fluid.makeFastInvoker(invokerec, invokeSpec, func);
                }
                togo = func.apply(null, invokeSpec.args === undefined ? args : invokeSpec.args);
            }
            if (fluid.defeatLogging === false) {
                fluid.popActivity();
            }
            return togo;
        };
    };

    // weird higher-order function so that we can staightforwardly dispatch original args back onto listener
    fluid.event.makeTrackedListenerAdder = function (source) {
        var shadow = fluid.shadowForComponent(source);
        return function (event) {
            return {addListener: function (listener) {
                    fluid.recordListener(event, listener, shadow);
                    event.addListener.apply(null, arguments);
                }
            };
        };
    };

    fluid.event.listenerEngine = function (eventSpec, callback, adder) {
        var argstruc = {};
        function checkFire() {
            var notall = fluid.find(eventSpec, function(value, key) {
                if (argstruc[key] === undefined) {
                    return true;
                }
            });
            if (!notall) {
                var oldstruc = argstruc;
                argstruc = {}; // guard against the case the callback perversely fires one of its prerequisites (FLUID-5112)
                callback(oldstruc);
            }
        }
        fluid.each(eventSpec, function (event, eventName) {
            adder(event).addListener(function () {
                argstruc[eventName] = fluid.makeArray(arguments);
                checkFire();
            });
        });
    };

    fluid.event.dispatchListener = function (that, listener, eventName, eventSpec, indirectArgs) {
        var togo = function () {
            fluid.pushActivity("dispatchListener", "firing to listener to event named %eventName of component %that",
                {eventName: eventName, that: that});

            var args = indirectArgs? arguments[0] : fluid.makeArray(arguments);
            if (eventSpec.args !== undefined) {
                if (!fluid.isArrayable(eventSpec.args)) {
                    eventSpec.args = fluid.makeArray(eventSpec.args);
                }
                args = fluid.expandOptions(eventSpec.args, that, null, {"arguments": args});
            }

            // TODO: create a "fast path" here as for invokers. Eliminate redundancy with invoker code
            var togo = fluid.event.invokeListener(listener, args);
            fluid.popActivity();
            return togo;
        };
        fluid.event.impersonateListener(listener, togo);
        return togo;
    };

    fluid.event.resolveSoftNamespace = function (key) {
        if (typeof(key) !== "string") {
            return null;
        } else {
            var lastpos = Math.max(key.lastIndexOf("."), key.lastIndexOf("}"));
            return key.substring(lastpos + 1);
        }
    };

    fluid.event.resolveListenerRecord = function (lisrec, that, eventName, namespace, standard) {
        var badRec = function (record, extra) {
            fluid.fail("Error in listener record - could not resolve reference ", record, " to a listener or firer. " +
                "Did you miss out \"events.\" when referring to an event firer?" + extra);
        };
        fluid.pushActivity("resolveListenerRecord", "resolving listener record for event named %eventName for component %that",
            {eventName: eventName, that: that});
        var records = fluid.makeArray(lisrec);
        var transRecs = fluid.transform(records, function (record) {
            // TODO: FLUID-5242 fix - we copy here since distributeOptions does not copy options blocks that it distributes and we can hence corrupt them.
            // need to clarify policy on options sharing - for slightly better efficiency, copy should happen during distribution and not here
            var expanded = fluid.isPrimitive(record) || record.expander ? {listener: record} : fluid.copy(record);
            var methodist = fluid.recordToApplicable(record, that);
            if (methodist) {
                expanded.listener = methodist;
            }
            else {
                expanded.listener = expanded.listener || expanded.func || expanded.funcName;
            }
            if (!expanded.listener) {
                badRec(record, " Listener record must contain a member named \"listener\", \"func\", \"funcName\" or \"method\"");
            }
            var softNamespace = record.method ?
                fluid.event.resolveSoftNamespace(record["this"]) + "." + record.method :
                fluid.event.resolveSoftNamespace(expanded.listener);
            if (!expanded.namespace && !namespace && softNamespace) {
                expanded.softNamespace = true;
                expanded.namespace = (record.componentSource ? record.componentSource : that.typeName) + "." + softNamespace;
            }
            var listener = expanded.listener = fluid.expandOptions(expanded.listener, that);
            if (!listener) {
                badRec(record, "");
            }
            var firer = false;
            if (listener.typeName === "fluid.event.firer") {
                listener = listener.fire;
                firer = true;
            }
            expanded.listener = (standard && (expanded.args || firer)) ? fluid.event.dispatchListener(that, listener, eventName, expanded) : listener;
            return expanded;
        });
        var togo = {
            records: transRecs,
            adderWrapper: standard ? fluid.event.makeTrackedListenerAdder(that) : null
        };
        fluid.popActivity();
        return togo;
    };

    fluid.event.expandOneEvent = function (that, event) {
        var origin;
        if (typeof(event) === "string" && event.charAt(0) !== "{") {
            // Shorthand for resolving onto our own events, but with GINGER WORLD!
            origin = fluid.getForComponent(that, ["events", event]);
        }
        else {
            origin = fluid.expandOptions(event, that);
        }
        if (!origin || origin.typeName !== "fluid.event.firer") {
            fluid.fail("Error in event specification - could not resolve base event reference ", event, " to an event firer: got ", origin);
        }
        return origin;
    };

    fluid.event.expandEvents = function (that, event) {
        return typeof(event) === "string" ?
            fluid.event.expandOneEvent(that, event) :
            fluid.transform(event, function (oneEvent) {
                return fluid.event.expandOneEvent(that, oneEvent);
            });
    };

    fluid.event.resolveEvent = function (that, eventName, eventSpec) {
        fluid.pushActivity("resolveEvent", "resolving event with name %eventName attached to component %that",
            {eventName: eventName, that: that});
        var adder = fluid.event.makeTrackedListenerAdder(that);
        if (typeof(eventSpec) === "string") {
            eventSpec = {event: eventSpec};
        }
        var event = eventSpec.event || eventSpec.events;
        if (!event) {
            fluid.fail("Event specification for event with name " + eventName + " does not include a base event specification: ", eventSpec);
        }

        var origin = fluid.event.expandEvents(that, event);

        var isMultiple = origin.typeName !== "fluid.event.firer";
        var isComposite = eventSpec.args || isMultiple;
        // If "event" is not composite, we want to share the listener list and FIRE method with the original
        // If "event" is composite, we need to create a new firer. "composite" includes case where any boiling
        // occurred - this was implemented wrongly in 1.4.
        var firer;
        if (isComposite) {
            firer = fluid.makeEventFirer({name: " [composite] " + fluid.event.nameEvent(that, eventName)});
            var dispatcher = fluid.event.dispatchListener(that, firer.fire, eventName, eventSpec, isMultiple);
            if (isMultiple) {
                fluid.event.listenerEngine(origin, dispatcher, adder);
            }
            else {
                adder(origin).addListener(dispatcher);
            }
        }
        else {
            firer = {typeName: "fluid.event.firer"}; // jslint:ok - already defined
            firer.fire = function () {
                var outerArgs = fluid.makeArray(arguments);
                fluid.pushActivity("fireSynthetic", "firing synthetic event %eventName ", {eventName: eventName});
                var togo = origin.fire.apply(null, outerArgs);
                fluid.popActivity();
                return togo;
            };
            firer.addListener = function (listener, namespace, predicate, priority, softNamespace) {
                var dispatcher = fluid.event.dispatchListener(that, listener, eventName, eventSpec);
                adder(origin).addListener(dispatcher, namespace, predicate, priority, softNamespace);
            };
            firer.removeListener = function (listener) {
                origin.removeListener(listener);
            };
        }
        fluid.popActivity();
        return firer;
    };

    /** BEGIN unofficial IoC material **/
    // Although the following three functions are unsupported and not part of the IoC
    // implementation proper, they are still used in the renderer
    // expander and Kettle as well as in some old-style tests and various places in CSpace.
    // Note that this implementation is a major impediment to removing manual component detection in the tree - we
    // need to move Kettle over to another system and/or improve our register of "cross-injected" components - as
    // well as adding code to add/remove them from this register as they come and go from the threadLocal.

    fluid.withEnvironment = function (envAdd, func, root) {
        root = root || fluid.globalThreadLocal();
        return fluid.tryCatch(function() {
            for (var key in envAdd) {
                root[key] = envAdd[key];
            }
            $.extend(root, envAdd);
            return func();
        }, null, function() {
            for (var key in envAdd) { // jslint:ok duplicate "value"
                delete root[key]; // TODO: users may want a recursive "scoping" model
            }
        });
    };

    fluid.fetchContextReference = function (parsed, directModel, env, elResolver, externalFetcher) {
        // The "elResolver" is a hack to make certain common idioms in protoTrees work correctly, where a contextualised EL
        // path actually resolves onto a further EL reference rather than directly onto a value target
        if (elResolver) {
            parsed = elResolver(parsed, env);
        }
        var base = parsed.context? env[parsed.context] : directModel;
        if (!base) {
            var resolveExternal = externalFetcher && externalFetcher(parsed);
            return resolveExternal || base;
        }
        return parsed.noDereference? parsed.path : fluid.get(base, parsed.path);
    };

    fluid.makeEnvironmentFetcher = function (directModel, elResolver, envGetter, externalFetcher) {
        envGetter = envGetter || fluid.globalThreadLocal;
        return function(parsed) {
            var env = envGetter();
            return fluid.fetchContextReference(parsed, directModel, env, elResolver, externalFetcher);
        };
    };

    /** END of unofficial IoC material **/
    
    /* Compact expansion machinery - for short form invoker and expander references such as @expand:func(arg) and func(arg) */

    fluid.coerceToPrimitive = function (string) {
        return string === "false" ? false : (string === "true" ? true :
            (isFinite(string) ? Number(string) : string));
    };

    fluid.compactStringToRec = function (string, type) {
        var openPos = string.indexOf("(");
        var closePos = string.indexOf(")");
        if (openPos === -1 ^ closePos === -1 || openPos > closePos) {
            fluid.fail("Badly-formed compact " + type + " record without matching parentheses: ", string);
        }
        if (openPos !== -1 && closePos !== -1) {
            var prefix = string.substring(0, openPos);
            var body = string.substring(openPos + 1, closePos);
            var args = fluid.transform(body.split(","), $.trim, fluid.coerceToPrimitive);
            var togo = {
                args: args
            };
            if (type === "invoker" && prefix.charAt(openPos - 1) === "!") {
                prefix = string.substring(0, openPos - 1);
                togo.dynamic = true;
            }
            togo[prefix.charAt(0) === "{" ? "func" : "funcName"] = prefix;
            return togo;
        }
        else if (type === "expander") {
            fluid.fail("Badly-formed compact expander record without parentheses: ", string);
        }
        return string;
    };

    fluid.expandPrefix = "@expand:";

    fluid.expandCompactString = function (string, active) {
        var rec = string;
        if (string.indexOf(fluid.expandPrefix) === 0) {
            var rem = string.substring(fluid.expandPrefix.length);
            rec = {
                expander: fluid.compactStringToRec(rem, "expander")
            };
        }
        else if (active) {
            rec = fluid.compactStringToRec(string, active);
        }
        return rec;
    };

    var singularPenRecord = {
        listeners: "listener",
        modelListeners: "modelListener"
    };

    var singularRecord = $.extend({
        invokers: "invoker"
    }, singularPenRecord);

    fluid.expandCompactRec = function (segs, target, source, userOptions) {
        var pen = segs.length > 0 ? segs[segs.length - 1] : "";
        var active = singularRecord[pen];
        if (!active && segs.length > 1) {
            active = singularPenRecord[segs[segs.length - 2]]; // support array of listeners and modelListeners
        }
        fluid.each(source, function (value, key) {
            // TODO: hack here to avoid corrupting old-style model references which were listed with "preserve" - eliminate this along with that mergePolicy
            if (fluid.isPlainObject(value) && !fluid.isDOMish(value) && !(userOptions && key === "model" && segs.length === 0)) {
                target[key] = fluid.freshContainer(value);
                segs.push(key);
                fluid.expandCompactRec(segs, target[key], value);
                segs.pop();
                return;
            }
            else if (typeof(value) === "string") {
                value = fluid.expandCompactString(value, active);
            }
            target[key] = value;
        });
    };

    fluid.expandCompact = function (options, userOptions) {
        var togo = {};
        fluid.expandCompactRec([], togo, options, userOptions);
        return togo;
    };
    
    /** End compact record expansion machinery **/

    fluid.extractEL = function (string, options) {
        if (options.ELstyle === "ALL") {
            return string;
        }
        else if (options.ELstyle.length === 1) {
            if (string.charAt(0) === options.ELstyle) {
                return string.substring(1);
            }
        }
        else if (options.ELstyle === "${}") {
            var i1 = string.indexOf("${");
            var i2 = string.lastIndexOf("}");
            if (i1 === 0 && i2 !== -1) {
                return string.substring(2, i2);
            }
        }
    };

    fluid.extractELWithContext = function (string, options) {
        var EL = fluid.extractEL(string, options);
        if (EL && EL.charAt(0) === "{" && EL.indexOf("}") > 0) {
            return fluid.parseContextReference(EL);
        }
        return EL? {path: EL} : EL;
    };

    fluid.parseContextReference = function (reference, index, delimiter) {
        index = index || 0;
        var endcpos = reference.indexOf("}", index + 1);
        if (endcpos === -1) {
            fluid.fail("Cannot parse context reference \"" + reference + "\": Malformed context reference without }");
        }
        var context = reference.substring(index + 1, endcpos);
        var endpos = delimiter? reference.indexOf(delimiter, endcpos + 1) : reference.length;
        var path = reference.substring(endcpos + 1, endpos);
        if (path.charAt(0) === ".") {
            path = path.substring(1);
        }
        return {context: context, path: path, endpos: endpos};
    };

    fluid.renderContextReference = function (parsed) {
        return "{" + parsed.context + "}" + (parsed.path ? "." + parsed.path : "");
    };

    fluid.resolveContextValue = function (string, options) {
        function fetch(parsed) {
            fluid.pushActivity("resolveContextValue", "resolving context value %string", {string: string});
            var togo = options.fetcher(parsed);
            fluid.pushActivity("resolvedContextValue", "resolved value %string to value %value", {string: string, value: togo});
            fluid.popActivity(2);
            return togo;
        }
        var parsed;
        if (options.bareContextRefs && string.charAt(0) === "{" && string.indexOf("}") > 0) {
            parsed = fluid.parseContextReference(string);
            return fetch(parsed);
        }
        else if (options.ELstyle && options.ELstyle !== "${}") {
            parsed = fluid.extractELWithContext(string, options);
            if (parsed) {
                return fetch(parsed);
            }
        }
        while (typeof(string) === "string") {
            var i1 = string.indexOf("${");
            var i2 = string.indexOf("}", i1 + 2);
            if (i1 !== -1 && i2 !== -1) {
                if (string.charAt(i1 + 2) === "{") {
                    parsed = fluid.parseContextReference(string, i1 + 2, "}");
                    i2 = parsed.endpos;
                }
                else {
                    parsed = {path: string.substring(i1 + 2, i2)};
                }
                var subs = fetch(parsed);
                var all = (i1 === 0 && i2 === string.length - 1);
                // TODO: test case for all undefined substitution
                if (subs === undefined || subs === null) {
                    return subs;
                }
                string = all? subs : string.substring(0, i1) + subs + string.substring(i2 + 1);
            }
            else {
                break;
            }
        }
        return string;
    };

    fluid.expandExpander = function (target, source, options) {
        var expander = fluid.getGlobalValue(source.expander.type || "fluid.deferredInvokeCall");
        if (expander) {
            return expander.call(null, target, source, options);
        }
    };

    // This function appears somewhat reusable, but not entirely - it probably needs to be packaged
    // along with the particular "strategy". Very similar to the old "filter"... the "outer driver" needs
    // to execute it to get the first recursion going at top level. This was one of the most odd results
    // of the reorganisation, since the "old work" seemed much more naturally expressed in terms of values
    // and what happened to them. The "new work" is expressed in terms of paths and how to move amongst them.
    fluid.fetchExpandChildren = function (target, i, segs, source, mergePolicy, miniWorld, options) {
        if (source.expander /* && source.expander.type */) { // possible expander at top level
            var expanded = fluid.expandExpander(target, source, options);
            if (options.freeRoot || fluid.isPrimitive(expanded) || fluid.isDOMish(expanded) || !fluid.isPlainObject(expanded) || (fluid.isArrayable(expanded) ^ fluid.isArrayable(target))) {
                return expanded;
            }
            else { // make an attempt to preserve the root reference if possible
                $.extend(true, target, expanded);
            }
        }
        // NOTE! This expects that RHS is concrete! For material input to "expansion" this happens to be the case, but is not
        // true for other algorithms. Inconsistently, this algorithm uses "sourceStrategy" below. In fact, this "fetchChildren"
        // operation looks like it is a fundamental primitive of the system. We do call "deliverer" early which enables correct
        // reference to parent nodes up the tree - however, anyone processing a tree IN THE CHAIN requires that it is produced
        // concretely at the point STRATEGY returns. Which in fact it is...............
        fluid.each(source, function (newSource, key) {
            if (newSource === undefined) {
                target[key] = undefined; // avoid ever dispatching to ourselves with undefined source
            }
            else if (key !== "expander") {
                segs[i] = key;
                options.strategy(target, key, i + 1, segs, source, mergePolicy, miniWorld);
            }
        });
        return target;
    };

    // TODO: This method is unnecessary and will quadratic inefficiency if RHS block is not concrete.
    // The driver should detect "homogeneous uni-strategy trundling" and agree to preserve the extra
    // "cursor arguments" which should be advertised somehow (at least their number)
    function regenerateCursor (source, segs, limit, sourceStrategy) {
        for (var i = 0; i < limit; ++ i) {
            // copy segs to avoid aliasing with FLUID-5243
            source = sourceStrategy(source, segs[i], i, fluid.makeArray(segs));
        }
        return source;
    }

    fluid.isUnexpandable = function (source) {
        return fluid.isPrimitive(source) || fluid.isComponent(source) || source.nodeType !== undefined || source.jquery || !fluid.isPlainObject(source);
    };

    fluid.expandSource = function (options, target, i, segs, deliverer, source, policy, miniWorld, recurse) {
        var expanded, isTrunk, isLate;
        var thisPolicy = fluid.derefMergePolicy(policy);
        if (typeof (source) === "string" && !thisPolicy.noexpand) {
            if (!options.defaultEL || source.charAt(0) === "{") { // hard-code this for performance
                fluid.pushActivity("expandContextValue", "expanding context value %source held at path %path", {source: source, path: fluid.path.apply(null, segs.slice(0, i))});
                expanded = fluid.resolveContextValue(source, options);
                fluid.popActivity(1);
            } else {
                expanded = source;
            }
        }
        else if (thisPolicy.noexpand || fluid.isUnexpandable(source)) {
            expanded = source;
        }
        else if (source.expander) {
            expanded = fluid.expandExpander(deliverer, source, options);
        }
        else {
            if (thisPolicy.preserve) {
                expanded = source;
                isLate = true;
            }
            else {
                expanded = fluid.freshContainer(source);
            }
            isTrunk = true;
        }
        if (!isLate && expanded !== fluid.NO_VALUE) {
            deliverer(expanded);
        }
        if (isTrunk) {
            recurse(expanded, source, i, segs, policy, miniWorld || isLate);
        }
        if (isLate && expanded !== fluid.NO_VALUE) {
            deliverer(expanded);
        }
        return expanded;
    };

    fluid.makeExpandStrategy = function (options) {
        var recurse = function (target, source, i, segs, policy, miniWorld) {
            return fluid.fetchExpandChildren(target, i || 0, segs || [], source, policy, miniWorld, options);
        };
        var strategy = function (target, name, i, segs, source, policy, miniWorld) {
            if (i > fluid.strategyRecursionBailout) {
                fluid.fail("Overflow/circularity in options expansion, current path is ", segs, " at depth " , i, " - please ensure options are not circularly connected, or protect from expansion using the \"noexpand\" policy or expander");
            }
            if (!target) {
                return;
            }
            if (!miniWorld && target.hasOwnProperty(name)) { // bail out if our work has already been done
                return target[name];
            }
            if (source === undefined) { // recover our state in case this is an external entry point
                source = regenerateCursor(options.source, segs, i - 1, options.sourceStrategy);
                policy = regenerateCursor(options.mergePolicy, segs, i - 1, fluid.concreteTrundler);
            }
            var thisSource = options.sourceStrategy(source, name, i, segs);
            var thisPolicy = fluid.concreteTrundler(policy, name);
            function deliverer(value) {
                target[name] = value;
            }
            return fluid.expandSource(options, target, i, segs, deliverer, thisSource, thisPolicy, miniWorld, recurse);
        };
        options.recurse = recurse;
        options.strategy = strategy;
        return strategy;
    };

    fluid.defaults("fluid.makeExpandOptions", {
        ELstyle:          "${}",
        bareContextRefs:  true,
        target:           fluid.inCreationMarker
    });

    fluid.makeExpandOptions = function (source, options) {
        options = $.extend({}, fluid.rawDefaults("fluid.makeExpandOptions"), options);
        options.defaultEL = options.ELStyle === "${}" && options.bareContextRefs; // optimisation to help expander
        options.expandSource = function (source) {
            return fluid.expandSource(options, null, 0, [], fluid.identity, source, options.mergePolicy, false);
        };
        if (!fluid.isUnexpandable(source)) {
            options.source = source;
            options.target = fluid.freshContainer(source);
            options.sourceStrategy = options.sourceStrategy || fluid.concreteTrundler;
            fluid.makeExpandStrategy(options);
            options.initter = function () {
                options.target = fluid.fetchExpandChildren(options.target, 0, [], options.source, options.mergePolicy, false, options);
            };
        }
        else { // these init immediately since we must deliver a valid root target
            options.strategy = fluid.concreteTrundler;
            options.initter = fluid.identity;
            if (typeof(source) === "string") {
                options.target = options.expandSource(source);
            }
            else {
                options.target = source;
            }
        }
        return options;
    };

    // supported, PUBLIC API function
    fluid.expand = function (source, options) {
        var expandOptions = fluid.makeExpandOptions(source, options);
        expandOptions.initter();
        return expandOptions.target;
    };

    fluid.registerNamespace("fluid.expander");

    /** "light" expanders, starting with the default expander deferredInvokeCall,
         which makes an arbitrary function call (after expanding arguments) and are then replaced in
         the configuration with the call results. These will probably be abolished and replaced with
         equivalent model transformation machinery **/

    // This one is now positioned as the "universal expander" - default if no type supplied
    fluid.deferredInvokeCall = function (deliverer, source, options) {
        var expander = source.expander;
        var args = fluid.makeArray(expander.args);
        args = options.recurse([], args); // TODO: risk of double expansion here. assembleCreatorArguments will sometimes expand, sometimes not...
        var funcEntry = expander.func || expander.funcName;
        var func = options.expandSource(funcEntry) || fluid.recordToApplicable(expander, options.contextThat);
        if (!func) {
            fluid.fail("Error in expander record - " + funcEntry + " could not be resolved to a function for component ", options.contextThat);
        }
        return func.apply ? func.apply(null, args) : fluid.invokeGlobalFunction(func, args);
    };

    // The "noexpand" expander which simply unwraps one level of expansion and ceases.
    fluid.noexpand = function (deliverer, source) {
        return source.expander.value ? source.expander.value : source.expander.tree;
    };

})(jQuery, fluid_2_0);
