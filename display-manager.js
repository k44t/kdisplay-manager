import argparse from 'argparse';
import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {getConfigDirPath, getSelectionStrategy, getStateDirPath, loadDisplayConfig, noteRecentConfig, readStateFile} from './runtime.js';
import {
	ensureTouchHelperBuilt,
	formatTouchMapperCommand,
	listTouchDevices,
	matchTouchDevice,
	startTouchMappers,
	stopTouchMappers
} from './touch-manager.js';


let {ArgumentParser} = argparse;
let execFileAsync = promisify(execFile);
let displays = null;


async function loadDisplays(configDir){
	displays = await loadDisplayConfig(configDir);
	return displays;
}


function getDisplays(){
	if(displays == null)
		throw new Error('Display manager config is not loaded');

	return displays;
}


function getInfoColumn(line){
	return line.search(/[0-9A-Za-z]/);
}


function parseIndentedInfoTree(sourceText){
	let root = {
		text: null,
		column: -1,
		children: []
	};
	let stack = [root];

	for(let rawLine of sourceText.split(/\r?\n/)){
		if(rawLine.trim() == '')
			continue;

		let column = getInfoColumn(rawLine);
		if(column < 0)
			continue;

		let node = {
			text: rawLine.slice(column),
			column,
			children: []
		};

		while(stack.length > 0 && stack[stack.length - 1].column >= column)
			stack.pop();

		stack[stack.length - 1].children.push(node);
		stack.push(node);
	}

	return root.children;
}


function parseScalar(value){
	value = value.trim();

	if(value == 'yes')
		return true;

	if(value == 'no')
		return false;

	if(value == 'None')
		return null;

	if(/^0\d+$/.test(value))
		return value;

	if(/^-?\d+$/.test(value))
		return Number.parseInt(value, 10);

	if(/^-?\d+\.\d+$/.test(value))
		return Number.parseFloat(value);

	let positionMatch = value.match(/^\((-?\d+),\s*(-?\d+)\)$/);
	if(positionMatch){
		return {
			x: Number.parseInt(positionMatch[1], 10),
			y: Number.parseInt(positionMatch[2], 10)
		};
	}

	let countMatch = value.match(/^\((\d+)\)$/);
	if(countMatch)
		return Number.parseInt(countMatch[1], 10);

	let listMatch = value.match(/^\[(.*)\]$/);
	if(listMatch){
		let inner = listMatch[1].trim();
		if(inner == '')
			return [];

		return inner.split(/\s*,\s*/).map(parseScalar);
	}

	return value;
}


function parseMode(value){
	let mode = {
		raw: value
	};
	let match = value.match(/^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/);
	if(match){
		mode.width = Number.parseInt(match[1], 10);
		mode.height = Number.parseInt(match[2], 10);
		mode.refreshRate = Number.parseFloat(match[3]);
	}
	return mode;
}


function parseMonitorHeading(text){
	let match = text.match(/^Monitor\s+(\S+)\s+\((.*)\)$/);
	if(!match){
		return {
			port: text
		};
	}

	return {
		port: match[1],
		displayName: match[2]
	};
}


function parseLogicalMonitorHeading(text){
	let match = text.match(/^Logical monitor\s+#(\d+)$/);
	if(!match){
		return {};
	}

	return {
		id: Number.parseInt(match[1], 10)
	};
}


function parseKeyValueText(text){
	let match = text.match(/^([^:]+):\s*(.*)$/);
	if(match == null)
		return null;

	return {
		key: match[1],
		value: match[2]
	};
}


function parsePropertyText(text){
	let match = text.match(/^(.*?)\s*⇒\s*(.*)$/);
	if(match == null)
		return null;

	return {
		key: match[1],
		value: match[2]
	};
}


function parsePreferences(node){
	let preferences = {};

	for(let child of node.children){
		let pair = parseKeyValueText(child.text);
		if(pair == null)
			continue;

		preferences[toPropertyName(pair.key)] = parseScalar(pair.value);
	}

	return preferences;
}


function parseProperties(node){
	let properties = {};

	for(let child of node.children){
		let pair = parsePropertyText(child.text);
		if(pair == null)
			continue;

		properties[toPropertyName(pair.key)] = parseScalar(pair.value);
	}

	return properties;
}


function parseModeNode(node){
	let mode = parseMode(node.text);

	for(let child of node.children){
		if(child.text.startsWith('Properties:')){
			mode.properties = parseProperties(child);
			continue;
		}

		let pair = parseKeyValueText(child.text);
		if(pair == null)
			continue;

		if(pair.key == 'Dimension'){
			let dimensionMatch = pair.value.match(/^(\d+)x(\d+)$/);
			if(dimensionMatch){
				mode.width = Number.parseInt(dimensionMatch[1], 10);
				mode.height = Number.parseInt(dimensionMatch[2], 10);
			}
			continue;
		}

		if(pair.key == 'Refresh rate'){
			mode.refreshRate = parseScalar(pair.value);
			continue;
		}

		mode[toPropertyName(pair.key)] = parseScalar(pair.value);
	}

	return mode;
}


function parseModes(node){
	let modes = node.children.map(parseModeNode);
	let currentMode = null;

	for(let mode of modes){
		if(mode.properties != null && mode.properties.isCurrent === true){
			currentMode = {
				raw: mode.raw,
				width: mode.width,
				height: mode.height,
				refreshRate: mode.refreshRate
			};
			break;
		}
		if(mode.properties != null && mode.properties.isPreferred === true && currentMode == null){
			currentMode = {
				raw: mode.raw,
				width: mode.width,
				height: mode.height,
				refreshRate: mode.refreshRate
			};
		}
	}

	return {
		modes,
		currentMode
	};
}


function parseMonitorNode(node){
	let monitor = parseMonitorHeading(node.text);

	for(let child of node.children){
		if(child.text.startsWith('Modes ')){
			let parsedModes = parseModes(child);
			monitor.modes = parsedModes.modes;
			monitor.currentMode = parsedModes.currentMode;
			continue;
		}

		if(child.text == 'Preferences'){
			monitor.preferences = parsePreferences(child);
			continue;
		}

		if(child.text.startsWith('Properties:')){
			monitor.properties = parseProperties(child);
			continue;
		}

		let pair = parseKeyValueText(child.text);
		if(pair == null)
			continue;

		monitor[toPropertyName(pair.key)] = parseScalar(pair.value);
	}

	return monitor;
}


function parseLogicalMonitorNode(node){
	let logicalMonitor = parseLogicalMonitorHeading(node.text);

	for(let child of node.children){
		let pair = parseKeyValueText(child.text);
		if(pair == null)
			continue;

		if(pair.key == 'Monitors'){
			logicalMonitor.monitorCount = parseScalar(pair.value);
			logicalMonitor.monitors = child.children.map(function(monitorNode){
				return parseMonitorReference(monitorNode.text);
			});
			continue;
		}

		if(pair.key == 'Properties')
			continue;

		logicalMonitor[toPropertyName(pair.key)] = parseScalar(pair.value);
	}

	if(logicalMonitor.monitors == null)
		logicalMonitor.monitors = [];

	return logicalMonitor;
}


function parseMonitorReference(text){
	let match = text.match(/^(\S+)\s+\((.*)\)$/);
	if(!match){
		return {
			port: text
		};
	}

	return {
		port: match[1],
		displayName: match[2]
	};
}


function toPropertyName(label){
	return label.replace(/[^0-9A-Za-z]+(.)/g, function(_, ch){
		return ch.toUpperCase();
	}).replace(/^[A-Z]/, function(ch){
		return ch.toLowerCase();
	});
}


function parseGdctlShow(sourceText){
	let tree = parseIndentedInfoTree(sourceText);
	let output = {
		monitors: [],
		logicalMonitors: []
	};

	for(let section of tree){
		if(section.text == 'Monitors:'){
			output.monitors = section.children.map(parseMonitorNode);
			continue;
		}

		if(section.text == 'Logical monitors:'){
			output.logicalMonitors = section.children.map(parseLogicalMonitorNode);
			continue;
		}
	}

	return output;
}


function isPlainObject(value){
	return value != null && typeof value == 'object' && !Array.isArray(value);
}


function deepClone(value){
	if(Array.isArray(value))
		return value.map(deepClone);

	if(isPlainObject(value)){
		let clone = {};
		for(let [key, childValue] of Object.entries(value))
			clone[key] = deepClone(childValue);
		return clone;
	}

	return value;
}


function mergeObjects(baseValue, overrideValue){
	if(Array.isArray(overrideValue))
		return deepClone(overrideValue);

	if(!isPlainObject(overrideValue))
		return deepClone(overrideValue);

	let output = isPlainObject(baseValue) ? deepClone(baseValue) : {};
	for(let [key, value] of Object.entries(overrideValue)){
		if(isPlainObject(value) && isPlainObject(output[key]))
			output[key] = mergeObjects(output[key], value);
		else
			output[key] = deepClone(value);
	}
	return output;
}


function splitConfigParts(config){
	let rootValues = {};
	let monitorValues = {};

	for(let [key, value] of Object.entries(config)){
		if(key == 'extends')
			continue;

		if(key.startsWith('#'))
			monitorValues[key] = value;
		else
			rootValues[key] = value;
	}

	return {
		rootValues,
		monitorValues
	};
}


function resolveConfigEntries(config){
	let parts = splitConfigParts(config);
	let resolved = deepClone(parts.rootValues);

	for(let [key, value] of Object.entries(parts.monitorValues)){
		resolved[key] = mergeObjects(parts.rootValues, value);
		if(resolved[key].monitors == null)
			resolved[key].monitors = [key.slice(1)];
	}

	return resolved;
}


function resolveConfig(name, seenNames = []){
	let rawConfig = getDisplays().configs[name];
	if(rawConfig == null)
		throw new Error('Unknown config: ' + name);

	if(seenNames.includes(name))
		throw new Error('Config extends cycle: ' + [...seenNames, name].join(' -> '));

	let merged = {};
	let extendsList = rawConfig.extends == null ? [] : Array.isArray(rawConfig.extends) ? rawConfig.extends : [rawConfig.extends];
	for(let parentName of extendsList)
		merged = mergeObjects(merged, resolveConfig(parentName, [...seenNames, name]));

	merged = mergeObjects(merged, rawConfig);
	delete merged.extends;

	return resolveConfigEntries(merged);
}


function listConfigs(){
	let resolvedConfigs = {};
	for(let name of Object.keys(getDisplays().configs))
		resolvedConfigs[name] = resolveConfig(name);
	return resolvedConfigs;
}


function getConfiguredMonitorNamesForMonitor(monitor){
	if(displays == null)
		return [];

	let matches = [];
	for(let [name, identity] of Object.entries(getDisplays().monitors)){
		if(matchesMonitorIdentity(monitor, identity))
			matches.push(name);
	}
	return matches;
}


function getConfigMonitorNames(config){
	let options = arguments[1] ?? {};
	let names = [];
	for(let entry of getConfigMonitorEntries(config)){
		if(entry.config.enable === false)
			continue;

		for(let reference of getNormalizedMonitorReferences(entry.config)){
			if(options.requiredOnly === true && reference.optional)
				continue;

			if(!names.includes(reference.name))
				names.push(reference.name);
		}
	}
	return names;
}


function getConfigMonitorCount(config){
	return getConfigMonitorNames(config, {requiredOnly: true}).length;
}


function isConfigAvailable(config, displayState){
	try{
		for(let name of getConfigMonitorNames(config, {requiredOnly: true}))
			resolveMonitorName(name, displayState);
		return true;
	}catch(err){
		return false;
	}
}


function filterAvailableConfigs(configs, displayState){
	let filteredConfigs = {};
	for(let [name, config] of Object.entries(configs)){
		if(isConfigAvailable(config, displayState))
			filteredConfigs[name] = config;
	}
	return filteredConfigs;
}


function filterMostSpecificConfigNames(configs, availableConfigNames){
	let maxMonitorCount = null;
	for(let name of availableConfigNames){
		let monitorCount = getConfigMonitorCount(configs[name]);
		if(maxMonitorCount == null || monitorCount > maxMonitorCount)
			maxMonitorCount = monitorCount;
	}

	return availableConfigNames.filter(function(name){
		return getConfigMonitorCount(configs[name]) === maxMonitorCount;
	});
}


function chooseConfigName(availableConfigNames, recentConfigNames, selectionStrategy){
	if(selectionStrategy === 'configuration-order')
		return availableConfigNames[0] ?? null;

	let availableConfigSet = new Set(availableConfigNames);
	for(let name of recentConfigNames){
		if(availableConfigSet.has(name))
			return name;
	}

	return availableConfigNames[0] ?? null;
}


async function selectConfigForDisplayState(displayState, options = {}){
	let configs = listConfigs();
	let availableConfigs = filterAvailableConfigs(configs, displayState);
	let availableConfigNames = Object.keys(availableConfigs);
	let selectionStrategy = getSelectionStrategy(getDisplays());
	let warnings = [];

	if(availableConfigNames.length === 0){
		return {
			configName: null,
			config: null,
			warnings
		};
	}

	if(selectionStrategy === 'most-monitors')
		availableConfigNames = filterMostSpecificConfigNames(configs, availableConfigNames);

	let knownConfigNames = new Set(Object.keys(configs));
	let recentConfigNames = await readStateFile(options.stateDir ?? getStateDirPath());
	for(let name of recentConfigNames){
		if(!knownConfigNames.has(name))
			warnings.push('ignoring unknown recent config: ' + name);
	}

	let configName = chooseConfigName(availableConfigNames, recentConfigNames, selectionStrategy);
	return {
		configName,
		config: configName == null ? null : configs[configName],
		warnings
	};
}


function getConfigMonitorEntries(config){
	let entries = [];
	for(let [key, value] of Object.entries(config)){
		if(key.startsWith('#')){
			entries.push({
				name: key,
				config: value
			});
		}
	}
	return entries;
}


function getConfigProperty(config, ...names){
	for(let name of names){
		if(config[name] != null)
			return config[name];
	}

	return null;
}


function matchesMonitorIdentity(monitor, identity){
	if(identity.vendor != null && monitor.vendor !== identity.vendor)
		return false;
	if(identity.product != null && monitor.product !== identity.product)
		return false;
	if(identity.serial != null && monitor.serial !== identity.serial)
		return false;
	return true;
}


function normalizeMonitorReference(reference, logicalMonitorConfig = {}){
	let defaultOptional = logicalMonitorConfig.optional === true;
	if(typeof reference == 'string'){
		return {
			name: reference,
			optional: defaultOptional
		};
	}

	if(!isPlainObject(reference))
		throw new Error('Invalid monitor reference: ' + JSON.stringify(reference));
	if(typeof reference.name != 'string' || reference.name.trim() == '')
		throw new Error('Monitor reference object must define a name');

	return {
		name: reference.name,
		optional: reference.optional == null ? defaultOptional : reference.optional === true
	};
}


function getNormalizedMonitorReferences(logicalMonitorConfig){
	return (logicalMonitorConfig.monitors ?? []).map(function(reference){
		return normalizeMonitorReference(reference, logicalMonitorConfig);
	});
}


function resolveMonitorName(name, displayState){
	let identity = getDisplays().monitors[name];
	if(identity == null)
		throw new Error('Unknown monitor name: ' + name);

	let matches = displayState.monitors.filter(function(monitor){
		return matchesMonitorIdentity(monitor, identity);
	});

	if(matches.length == 0)
		throw new Error('Monitor not connected: ' + name);
	if(matches.length > 1)
		throw new Error('Monitor name matches multiple connected monitors: ' + name);

	return matches[0];
}


function isMonitorNotConnectedError(err){
	return err instanceof Error && err.message.startsWith('Monitor not connected: ');
}


function resolveConfiguredMonitor(reference, displayState){
	try{
		return resolveMonitorName(reference.name, displayState);
	}catch(err){
		if(reference.optional && isMonitorNotConnectedError(err))
			return null;
		throw err;
	}
}


function getRelationKey(logicalMonitorConfig){
	for(let key of ['right-of', 'left-of', 'above', 'below']){
		if(logicalMonitorConfig[key] != null)
			return key;
	}
	return null;
}


function resolveReferencePort(reference, logicalMonitorPorts, displayState){
	if(reference.startsWith('#')){
		if(logicalMonitorPorts[reference] == null)
			throw new Error('Unknown logical monitor reference: ' + reference);
		return logicalMonitorPorts[reference];
	}

	if(getDisplays().monitors[reference] != null)
		return resolveMonitorName(reference, displayState).port;

	return reference;
}


function sortLogicalMonitorEntries(entries){
	let remaining = entries.slice();
	let sorted = [];
	let sortedNames = new Set();

	while(remaining.length > 0){
		let nextIndex = remaining.findIndex(function(entry){
			let relationKey = getRelationKey(entry.config);
			if(relationKey == null)
				return true;
			let reference = entry.config[relationKey];
			if(typeof reference != 'string' || !reference.startsWith('#'))
				return true;
			return sortedNames.has(reference);
		});

		if(nextIndex < 0)
			throw new Error('Could not resolve logical monitor ordering');

		let entry = remaining.splice(nextIndex, 1)[0];
		sorted.push(entry);
		sortedNames.add(entry.name);
	}

	return sorted;
}


function parseRequestedMode(modeText){
	let match = modeText.match(/^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/);
	if(match == null)
		throw new Error('Invalid mode: ' + modeText);

	return {
		width: Number.parseInt(match[1], 10),
		height: Number.parseInt(match[2], 10),
		refreshRate: match[3] == null ? null : Number.parseFloat(match[3])
	};
}


function sameRefreshRate(a, b){
	return Math.abs(a - b) < 0.001;
}


function resolveModeForMonitor(monitor, modeText){
	let requestedMode = parseRequestedMode(modeText);
	if(requestedMode.refreshRate != null)
		return modeText;

	if(!Array.isArray(monitor.modes) || monitor.modes.length == 0)
		throw new Error('Monitor has no parsed modes: ' + monitor.port);

	let matchingModes = monitor.modes.filter(function(mode){
		return mode.width === requestedMode.width && mode.height === requestedMode.height;
	});

	if(matchingModes.length == 0)
		throw new Error('Unsupported mode ' + modeText + ' for monitor ' + monitor.port);

	let currentRefreshRate = monitor.currentMode != null ? monitor.currentMode.refreshRate : null;
	if(currentRefreshRate != null){
		let currentRateMatch = matchingModes.find(function(mode){
			return mode.refreshRate != null && sameRefreshRate(mode.refreshRate, currentRefreshRate);
		});
		if(currentRateMatch != null)
			return currentRateMatch.raw;
	}

	let preferredMatch = matchingModes.find(function(mode){
		return mode.properties != null && mode.properties.isPreferred === true;
	});
	if(preferredMatch != null)
		return preferredMatch.raw;

	return matchingModes[0].raw;
}


function getModeDimensions(modeText){
	let requestedMode = parseRequestedMode(modeText);
	return {
		width: requestedMode.width,
		height: requestedMode.height
	};
}


function getLogicalMonitorSize(logicalMonitorConfig, resolvedModeText){
	let scale = getConfigProperty(logicalMonitorConfig, 'scale');
	if(scale == null)
		scale = 1;

	let mode = getModeDimensions(resolvedModeText);
	let width = Math.round(mode.width / scale);
	let height = Math.round(mode.height / scale);
	let transform = getConfigProperty(logicalMonitorConfig, 'transform');
	if(transform == '90' || transform == '270' || transform == 'flipped-90' || transform == 'flipped-270'){
		return {
			width: height,
			height: width
		};
	}

	return {
		width,
		height
	};
}


function getOffsetValue(logicalMonitorConfig, key){
	let value = getConfigProperty(logicalMonitorConfig, key);
	if(value == null)
		return 0;
	return value;
}


function getAlignmentOffset(alignment, referenceSize, entrySize, relationKey){
	if(alignment == null)
		return 0;

	if(alignment == 'left' || alignment == 'top')
		return 0;
	if(alignment == 'center')
		return Math.round((referenceSize - entrySize) / 2);
	if(alignment == 'right' || alignment == 'bottom')
		return referenceSize - entrySize;

	throw new Error('Unsupported alignment ' + alignment + ' for logical monitor relation ' + relationKey);
}


function applyRelativeAlignment(position, logicalMonitorConfig, referenceEntry, entry, relationKey){
	let alignment = getConfigProperty(logicalMonitorConfig, 'align');
	if(alignment == null)
		return position;

	if(relationKey == null)
		throw new Error('Logical monitor align requires a relative position: ' + entry.name);

	if(relationKey == 'above' || relationKey == 'below'){
		if(!['left', 'center', 'right'].includes(alignment))
			throw new Error('Alignment for ' + relationKey + ' must be left, center, or right: ' + entry.name);

		position.x = referenceEntry.x + getAlignmentOffset(alignment, referenceEntry.width, entry.width, relationKey);
		return position;
	}

	if(relationKey == 'left-of' || relationKey == 'right-of'){
		if(!['top', 'center', 'bottom'].includes(alignment))
			throw new Error('Alignment for ' + relationKey + ' must be top, center, or bottom: ' + entry.name);

		position.y = referenceEntry.y + getAlignmentOffset(alignment, referenceEntry.height, entry.height, relationKey);
		return position;
	}

	return position;
}


function computeLogicalMonitorPosition(entry, resolvedEntriesByName){
	let logicalMonitorConfig = entry.config;
	let relationKey = getRelationKey(logicalMonitorConfig);
	let x = getConfigProperty(logicalMonitorConfig, 'x');
	let y = getConfigProperty(logicalMonitorConfig, 'y');
	let referenceEntry = null;

	if(x == null)
		x = 0;
	if(y == null)
		y = 0;

	if(relationKey != null){
		let referenceName = logicalMonitorConfig[relationKey];
		if(typeof referenceName != 'string' || !referenceName.startsWith('#'))
			throw new Error('Relative positioning must reference another logical monitor: ' + entry.name);

		referenceEntry = resolvedEntriesByName[referenceName];
		if(referenceEntry == null)
			throw new Error('Unknown logical monitor reference: ' + referenceName);

		x = referenceEntry.x;
		y = referenceEntry.y;

		if(relationKey == 'left-of')
			x -= entry.width;
		if(relationKey == 'right-of')
			x += referenceEntry.width;
		if(relationKey == 'above')
			y -= entry.height;
		if(relationKey == 'below')
			y += referenceEntry.height;
	}

	({x, y} = applyRelativeAlignment({x, y}, logicalMonitorConfig, referenceEntry, entry, relationKey));

	x += getOffsetValue(logicalMonitorConfig, 'offsetX');
	y += getOffsetValue(logicalMonitorConfig, 'offsetY');

	return {x, y};
}


function normalizeLogicalMonitorPositions(entries){
	let minX = Math.min(...entries.map(function(entry){
		return entry.x;
	}));
	let minY = Math.min(...entries.map(function(entry){
		return entry.y;
	}));

	for(let entry of entries){
		entry.x -= minX;
		entry.y -= minY;
	}

	return entries;
}


function resolveLogicalMonitorEntries(config, displayState){
	let entries = getConfigMonitorEntries(config).filter(function(entry){
		return entry.config.enable !== false;
	});
	entries = sortLogicalMonitorEntries(entries);

	let resolvedEntries = [];
	let resolvedEntriesByName = {};

	for(let entry of entries){
		let connectedMonitors = getNormalizedMonitorReferences(entry.config).map(function(reference){
			return resolveConfiguredMonitor(reference, displayState);
		}).filter(function(monitor){
			return monitor != null;
		});

		if(connectedMonitors[0] == null)
			continue;

		let modeText = null;
		if(getConfigProperty(entry.config, 'mode') != null)
			modeText = resolveModeForMonitor(connectedMonitors[0], getConfigProperty(entry.config, 'mode'));
		else if(connectedMonitors[0].currentMode != null)
			modeText = connectedMonitors[0].currentMode.raw;

		if(modeText == null)
			throw new Error('Could not determine mode for logical monitor: ' + entry.name);

		let size = getLogicalMonitorSize(entry.config, modeText);
		let resolvedEntry = {
			name: entry.name,
			config: entry.config,
			connectedMonitors,
			modeText,
			width: size.width,
			height: size.height,
			x: 0,
			y: 0
		};

		let position = computeLogicalMonitorPosition(resolvedEntry, resolvedEntriesByName);
		resolvedEntry.x = position.x;
		resolvedEntry.y = position.y;

		resolvedEntries.push(resolvedEntry);
		resolvedEntriesByName[resolvedEntry.name] = resolvedEntry;
	}

	resolvedEntries = normalizePrimary(resolvedEntries);
	if(resolvedEntries.length == 0)
		return resolvedEntries;

	return normalizeLogicalMonitorPositions(resolvedEntries);
}


function normalizePrimary(entries){
	let primaryEntries = entries.filter(function(entry){
		return entry.config.primary === true;
	});

	if(primaryEntries.length > 1)
		throw new Error('Config declares multiple primary logical monitors');

	return entries;
}


function getDesktopBounds(entries){
	let width = 0;
	let height = 0;
	for(let entry of entries){
		width = Math.max(width, entry.x + entry.width);
		height = Math.max(height, entry.y + entry.height);
	}
	return {width, height};
}


function getAffineMatrixForTransform(transformName){
	switch(transformName ?? 'normal'){
		case 'normal':
			return [1, 0, 0, 0, 1, 0];
		case '90':
			return [0, -1, 1, 1, 0, 0];
		case '180':
			return [-1, 0, 1, 0, -1, 1];
		case '270':
			return [0, 1, 0, -1, 0, 1];
		case 'flipped':
			return [-1, 0, 1, 0, 1, 0];
		case 'flipped-90':
			return [0, 1, 0, 1, 0, 0];
		case 'flipped-180':
			return [1, 0, 0, 0, -1, 1];
		case 'flipped-270':
			return [0, -1, 1, -1, 0, 1];
		default:
			throw new Error('Unsupported touch transform: ' + transformName);
	}
}


function composeAffineMatrices(left, right){
	return [
		left[0] * right[0] + left[1] * right[3],
		left[0] * right[1] + left[1] * right[4],
		left[0] * right[2] + left[1] * right[5] + left[2],
		left[3] * right[0] + left[4] * right[3],
		left[3] * right[1] + left[4] * right[4],
		left[3] * right[2] + left[4] * right[5] + left[5]
	];
}


function getTouchTransform(entry, touchIdentity){
	if(touchIdentity.transform != null)
		return touchIdentity.transform;
	if(entry.config.touchTransform != null)
		return entry.config.touchTransform;
	return getConfigProperty(entry.config, 'transform') ?? 'normal';
}


function getTouchMatrix(entry, desktopBounds, touchIdentity){
	if(desktopBounds.width <= 0 || desktopBounds.height <= 0)
		throw new Error('Cannot compute touch matrix without desktop bounds');

	let targetMatrix = [
		entry.width / desktopBounds.width,
		0,
		entry.x / desktopBounds.width,
		0,
		entry.height / desktopBounds.height,
		entry.y / desktopBounds.height
	];
	let localMatrix = getAffineMatrixForTransform(getTouchTransform(entry, touchIdentity));
	return composeAffineMatrices(targetMatrix, localMatrix).map(function(value){
		return Number.parseFloat(value.toFixed(9));
	});
}


async function getTouchMappings(config, displayState){
	let entries = resolveLogicalMonitorEntries(config, displayState);
	if(entries.length === 0)
		return {
			mappings: [],
			warnings: []
		};

	let devices = await listTouchDevices();
	let desktopBounds = getDesktopBounds(entries);
	let mappings = [];
	let usedDevicePaths = new Set();
	let warnings = [];

	for(let entry of entries){
		let resolvedTouchTargets = new Map();
		for(let reference of getNormalizedMonitorReferences(entry.config)){
			let touchIdentity = getDisplays().monitors[reference.name]?.touch;
			if(touchIdentity == null)
				continue;

			let monitor = resolveConfiguredMonitor(reference, displayState);
			if(monitor == null)
				continue;

			let monitorKey = [monitor.vendor ?? '', monitor.product ?? '', monitor.serial ?? '', monitor.port ?? ''].join('\u0000');
			if(!resolvedTouchTargets.has(monitorKey)){
				resolvedTouchTargets.set(monitorKey, {
					referenceName: reference.name,
					touchIdentity
				});
			}
		}

		for(let {referenceName, touchIdentity} of resolvedTouchTargets.values()){
			let matches = devices.filter(function(device){
				return matchTouchDevice(device, touchIdentity);
			});
			if(matches.length > 1){
				let touchscreenMatches = matches.filter(function(device){
					return device.isTouchscreen;
				});
				if(touchscreenMatches.length === 1)
					matches = touchscreenMatches;
			}
			if(matches.length === 0){
				warnings.push('No touch device matched monitor ' + referenceName);
				continue;
			}
			if(matches.length > 1){
				warnings.push('Multiple touch devices matched monitor ' + referenceName);
				continue;
			}

			let device = matches[0];
			let devicePath = device.byIdPath ?? device.byPathPath ?? device.eventPath;
			if(usedDevicePaths.has(devicePath)){
				warnings.push('Touch device already assigned, skipping duplicate mapping: ' + devicePath);
				continue;
			}
			usedDevicePaths.add(devicePath);

			mappings.push({
				monitorName: referenceName,
				logicalMonitorName: entry.name,
				devicePath,
				device,
				matrix: getTouchMatrix(entry, desktopBounds, touchIdentity),
				virtualDeviceName: 'kdisplay-manager ' + referenceName
			});
		}
	}

	return {
		mappings,
		warnings
	};
}


function getMonitorDefinitionProperty(monitorName, propertyName){
	let displays = getDisplays();
	let monitor = displays.monitors[monitorName] ?? {};
	if(monitor[propertyName] != null)
		return monitor[propertyName];
	return displays[propertyName] ?? null;
}


function getWirePlumberConfigDirPath(){
	let configHome = process.env.XDG_CONFIG_HOME;
	if(typeof configHome != 'string' || configHome.trim() == '')
		configHome = path.join(os.homedir(), '.config');
	return path.join(configHome, 'wireplumber', 'wireplumber.conf.d');
}


function getManagedAudioRenameConfigPath(){
	return path.join(getWirePlumberConfigDirPath(), 'kdisplay-manager.conf');
}


function getAcpConfigRootPath(){
	let configHome = process.env.XDG_CONFIG_HOME;
	if(typeof configHome != 'string' || configHome.trim() == '')
		configHome = path.join(os.homedir(), '.config');
	return path.join(configHome, 'alsa-card-profile', 'mixer');
}


function getAcpProfileSetsDirPath(){
	return path.join(getAcpConfigRootPath(), 'profile-sets');
}


function getAcpPathsDirPath(){
	return path.join(getAcpConfigRootPath(), 'paths');
}


function getManagedAcpProfileSetName(){
	return 'kdisplay-manager.conf';
}


function getManagedAcpProfileSetPath(){
	return path.join(getAcpProfileSetsDirPath(), getManagedAcpProfileSetName());
}


function getManagedAcpPathFileName(audioPortName){
	return 'kdisplay-manager-' + audioPortName + '.conf';
}


function getManagedAcpPathFilePath(audioPortName){
	return path.join(getAcpPathsDirPath(), getManagedAcpPathFileName(audioPortName));
}


function getSystemAcpProfileSetPath(){
	return '/usr/share/alsa-card-profile/mixer/profile-sets/default.conf';
}


function getSystemAcpPathFilePath(audioPortName){
	return path.join('/usr/share/alsa-card-profile/mixer/paths', audioPortName + '.conf');
}


function formatConfigString(value){
	return JSON.stringify(value);
}


function getRenameAudioLabel(monitorName){
	let renameAudio = getMonitorDefinitionProperty(monitorName, 'renameAudio');
	if(renameAudio == null || renameAudio === false)
		return null;
	if(renameAudio === true)
		return monitorName.startsWith('#') ? monitorName.slice(1) : monitorName;
	if(typeof renameAudio == 'string' && renameAudio.trim() != '')
		return renameAudio;
	throw new Error('renameAudio must be false, true, or a non-empty string: ' + monitorName);
}


function parseTrailingNumber(value){
	let match = value.match(/(\d+)$/);
	if(match == null)
		return null;
	return Number.parseInt(match[1], 10);
}


function compareOrderedNames(left, right){
	let leftPrefix = left.replace(/\d+$/, '');
	let rightPrefix = right.replace(/\d+$/, '');
	if(leftPrefix !== rightPrefix)
		return leftPrefix.localeCompare(rightPrefix);

	let leftNumber = parseTrailingNumber(left);
	let rightNumber = parseTrailingNumber(right);
	if(leftNumber == null || rightNumber == null)
		return left.localeCompare(right);
	return leftNumber - rightNumber;
}


async function runPactlJson(args){
	let result = await execFileAsync('pactl', ['--format=json', ...args], {
		encoding: 'utf8'
	});
	return JSON.parse(result.stdout);
}


function getSinkDescription(sink){
	if(sink == null)
		return null;
	return sink.description ?? sink.properties?.['device.description'] ?? null;
}


function getMonitorAudioPorts(cards){
	let ports = [];
	for(let card of cards){
		if(!isPlainObject(card.ports))
			continue;

		for(let [name, port] of Object.entries(card.ports)){
			if(!name.startsWith('hdmi-output-'))
				continue;
			if(port.availability === 'not available')
				continue;

			let product = port.properties?.['device.product.name'];
			if(typeof product != 'string' || product.trim() == '')
				continue;

			ports.push({
				name,
				product,
				routeIndex: parseTrailingNumber(name),
				profileNames: Array.isArray(port.profiles) ? port.profiles.slice() : []
			});
		}
	}
	return ports;
}


function getSinkActivePortName(sink){
	if(typeof sink.active_port == 'string')
		return sink.active_port;
	if(isPlainObject(sink.active_port) && typeof sink.active_port.name == 'string')
		return sink.active_port.name;
	return null;
}


function sinkMatchesAudioPort(sink, audioPort){
	let properties = sink.properties ?? {};
	let activePortName = getSinkActivePortName(sink);
	if(activePortName === audioPort.name)
		return true;

	if(audioPort.routeIndex != null){
		if(properties['api.alsa.path'] === 'hdmi:' + audioPort.routeIndex)
			return true;
		if(properties['alsa.id'] === 'HDMI ' + audioPort.routeIndex)
			return true;
	}

	let profileName = properties['device.profile.name'];
	if(typeof profileName == 'string'){
		if(audioPort.profileNames.includes(profileName))
			return true;
		if(audioPort.profileNames.includes('output:' + profileName))
			return true;
	}

	return false;
}


function groupBy(items, getKey){
	let groups = new Map();
	for(let item of items){
		let key = getKey(item);
		if(!groups.has(key))
			groups.set(key, []);
		groups.get(key).push(item);
	}
	return groups;
}


function buildAudioMonitorTargets(config, displayState){
	let entries = resolveLogicalMonitorEntries(config, displayState);
	let monitorTargets = [];
	for(let entry of entries){
		for(let reference of getNormalizedMonitorReferences(entry.config)){
			let monitor = resolveConfiguredMonitor(reference, displayState);
			if(monitor == null)
				continue;
			if(typeof monitor.product != 'string' || monitor.product.trim() == '')
				continue;

			monitorTargets.push({
				entryName: entry.name,
				label: getRenameAudioLabel(reference.name),
				product: monitor.product,
				port: monitor.port
			});
		}
	}
	return monitorTargets;
}


function getAudioPortByName(cards, audioPortName){
	for(let card of cards){
		if(card.ports?.[audioPortName] == null)
			continue;
		let port = card.ports[audioPortName];
		return {
			cardName: card.name ?? null,
			name: audioPortName,
			product: port.properties?.['device.product.name'] ?? null,
			routeIndex: getAudioPortRouteIndex(audioPortName),
			profileNames: Array.isArray(port.profiles) ? port.profiles.slice() : []
		};
	}
	return null;
}


async function getResolvedAudioMappings(config, displayState){
	let monitorTargets = buildAudioMonitorTargets(config, displayState);
	let [cards, sinks] = await Promise.all([
		runPactlJson(['list', 'cards']),
		runPactlJson(['list', 'sinks'])
	]);
	let audioPorts = getMonitorAudioPorts(cards);
	let warnings = [];
	let targetByAudioPortName = new Map();
	let monitorGroups = groupBy(monitorTargets, function(target){
		return target.product;
	});
	let audioGroups = groupBy(audioPorts, function(port){
		return port.product;
	});

	for(let [product, targets] of monitorGroups.entries()){
		let matchingAudioPorts = audioGroups.get(product) ?? [];
		if(matchingAudioPorts.length === 0){
			for(let target of targets)
				warnings.push('No audio port matched monitor ' + target.port + ' (' + product + ')');
			continue;
		}

		if(matchingAudioPorts.length !== targets.length){
			warnings.push('Audio port count mismatch for product ' + product + ': monitors=' + targets.length + ', audioPorts=' + matchingAudioPorts.length);
			continue;
		}

		let sortedTargets = targets.slice().sort(function(left, right){
			return compareOrderedNames(left.port, right.port);
		});
		let sortedAudioPorts = matchingAudioPorts.slice().sort(function(left, right){
			return compareOrderedNames(left.name, right.name);
		});

		for(let index = 0; index < sortedTargets.length; index++)
			targetByAudioPortName.set(sortedAudioPorts[index].name, sortedTargets[index]);
	}

	let sinksByAudioPortName = new Map();
	let unmatchedSinks = [];
	for(let sink of sinks){
		let matchingAudioPorts = audioPorts.filter(function(audioPort){
			return sinkMatchesAudioPort(sink, audioPort);
		});

		if(matchingAudioPorts.length > 1)
			warnings.push('Multiple audio ports matched sink ' + sink.name);

		if(matchingAudioPorts.length === 1){
			let audioPort = matchingAudioPorts[0];
			if(!sinksByAudioPortName.has(audioPort.name))
				sinksByAudioPortName.set(audioPort.name, []);
			sinksByAudioPortName.get(audioPort.name).push(sink);
			continue;
		}

		unmatchedSinks.push(sink);
	}

	let mappings = audioPorts.map(function(audioPort){
		let matchingSinks = sinksByAudioPortName.get(audioPort.name) ?? [];
		let sink = matchingSinks.length > 0 ? matchingSinks[0] : null;
		let target = targetByAudioPortName.get(audioPort.name) ?? null;
		return {
			sinkIndex: sink?.index ?? null,
			sinkName: sink?.name ?? null,
			sinkDescription: getSinkDescription(sink),
			audioPortName: audioPort.name,
			product: audioPort.product,
			monitorPort: target?.port ?? null,
			logicalMonitorName: target?.entryName ?? null,
			rename: matchingSinks.length === 1 && target?.port != null && target?.label != null,
			renameDescription: target?.label ?? null
		};
	});

	for(let sink of unmatchedSinks){
		mappings.push({
			sinkIndex: sink.index,
			sinkName: sink.name,
			sinkDescription: getSinkDescription(sink),
			audioPortName: null,
			product: null,
			monitorPort: null,
			logicalMonitorName: null,
			rename: false,
			renameDescription: null
		});
	}

	for(let [audioPortName, target] of targetByAudioPortName.entries()){
		let matchingSinks = sinksByAudioPortName.get(audioPortName) ?? [];
		if(matchingSinks.length === 0)
			warnings.push('No sink matched audio port ' + audioPortName + ' for monitor ' + target.port);
		if(matchingSinks.length > 1)
			warnings.push('Multiple sinks matched audio port ' + audioPortName + ' for monitor ' + target.port);
	}

	return {mappings, warnings};
}


async function getAudioRenames(config, displayState){
	let cards = await runPactlJson(['list', 'cards']);
	let resolved = await getResolvedAudioMappings(config, displayState);
	let renames = resolved.mappings.filter(function(mapping){
		return typeof mapping.audioPortName == 'string' && typeof mapping.renameDescription == 'string' && mapping.renameDescription.trim() != '';
	}).map(function(mapping){
		let audioPort = getAudioPortByName(cards, mapping.audioPortName);
		return {
			sinkIndex: mapping.sinkIndex,
			sinkName: mapping.sinkName,
			description: mapping.renameDescription,
			monitorPort: mapping.monitorPort,
			audioPortName: mapping.audioPortName,
			cardName: audioPort?.cardName ?? null,
			profileNames: audioPort?.profileNames ?? []
		};
	});

	return {
		renames,
		warnings: resolved.warnings
	};
}


async function getAudioRenamePlan(name, options = {}){
	let displayState = options.displayState ?? await getDisplayState();
	let selection = null;
	if(name == null){
		selection = await selectConfigForDisplayState(displayState, options);
		name = selection.configName;
		if(name == null)
			throw new Error('No applicable config for current displays');
	}

	let config = selection?.config ?? resolveConfig(name);
	let audioResult = await getResolvedAudioMappings(config, displayState);
	return {
		configName: name,
		config,
		displayState,
		audioMappings: audioResult.mappings,
		warnings: [
			...(selection?.warnings ?? []),
			...audioResult.warnings
		]
	};
}


async function resolveApplyPlan(name, options = {}){
	let displayState = options.displayState ?? await getDisplayState();
	let selection = null;
	if(name == null){
		selection = await selectConfigForDisplayState(displayState, options);
		name = selection.configName;
		if(name == null)
			throw new Error('No applicable config for current displays');
	}

	let config = selection?.config ?? resolveConfig(name);
	let [touchResult, audioResult] = await Promise.all([
		getTouchMappings(config, displayState),
		getAudioRenames(config, displayState)
	]);
	return {
		configName: name,
		config,
		displayState,
		gdctlArgs: buildSetArgs(config, displayState),
		touchMappings: touchResult.mappings,
		audioRenames: audioResult.renames,
		warnings: [
			...(selection?.warnings ?? []),
			...touchResult.warnings,
			...audioResult.warnings
		]
	};
}


function buildSetArgs(config, displayState){
	let args = ['set'];
	let entries = resolveLogicalMonitorEntries(config, displayState);
	if(entries.length == 0)
		return [];

	for(let entry of entries){
		let logicalMonitorConfig = entry.config;
		let connectedMonitors = entry.connectedMonitors;

		args.push('--logical-monitor');

		if(getConfigProperty(logicalMonitorConfig, 'primary') === true)
			args.push('--primary');
		if(getConfigProperty(logicalMonitorConfig, 'scale') != null)
			args.push('--scale', '' + getConfigProperty(logicalMonitorConfig, 'scale'));
		if(getConfigProperty(logicalMonitorConfig, 'transform') != null)
			args.push('--transform', getConfigProperty(logicalMonitorConfig, 'transform'));
		args.push('--x', '' + entry.x);
		args.push('--y', '' + entry.y);

		for(let monitor of connectedMonitors){
			args.push('--monitor', monitor.port);
			args.push('--mode', resolveModeForMonitor(monitor, entry.modeText));
			if(getConfigProperty(logicalMonitorConfig, 'colorMode', 'color-mode') != null)
				args.push('--color-mode', getConfigProperty(logicalMonitorConfig, 'colorMode', 'color-mode'));
			if(getConfigProperty(logicalMonitorConfig, 'rgbRange', 'rgb-range') != null)
				args.push('--rgb-range', getConfigProperty(logicalMonitorConfig, 'rgbRange', 'rgb-range'));
		}
	}

	return args;
}


async function applyConfig(name){
	let config = resolveConfig(name);
	let displayState = await getDisplayState();
	return buildSetArgs(config, displayState);
}


function shellQuote(value){
	if(/^[A-Za-z0-9_./:-]+$/.test(value))
		return value;

	return "'" + value.replace(/'/g, "'\\''") + "'";
}


function formatCommand(command){
	return command.map(shellQuote).join(' ');
}


function formatManagedAudioRenameAction(action, filePath){
	return action + ' ' + shellQuote(filePath);
}


function getAudioPortRouteIndex(audioPortName){
	return parseTrailingNumber(audioPortName);
}


function buildWirePlumberAudioRenameConfig(renames){
	let uniqueRenames = new Map();
	for(let rename of renames ?? []){
		if(typeof rename.audioPortName != 'string' || rename.audioPortName.trim() == '')
			continue;
		if(typeof rename.description != 'string' || rename.description.trim() == '')
			continue;
		uniqueRenames.set(rename.audioPortName, {
			cardName: rename.cardName ?? null,
			description: rename.description.trim(),
			profileNames: Array.isArray(rename.profileNames) ? rename.profileNames.slice() : []
		});
	}

	if(uniqueRenames.size === 0)
		return null;

	let lines = ['monitor.alsa.rules = ['];
	let cardNames = [...new Set([...uniqueRenames.values()].map(function(rename){
		return rename.cardName;
	}).filter(function(cardName){
		return typeof cardName == 'string' && cardName.trim() != '';
	}))];
	for(let cardName of cardNames){
		lines.push('\t{');
		lines.push('\t\tmatches = [');
		lines.push('\t\t\t{');
		lines.push('\t\t\t\tdevice.api = "alsa"');
		lines.push('\t\t\t\tdevice.name = ' + formatConfigString(cardName));
		lines.push('\t\t\t}');
		lines.push('\t\t]');
		lines.push('\t\tactions = {');
		lines.push('\t\t\tupdate-props = {');
		lines.push('\t\t\t\tdevice.profile-set = ' + formatConfigString(getManagedAcpProfileSetName()));
		lines.push('\t\t\t}');
		lines.push('\t\t}');
		lines.push('\t}');
	}
	for(let [audioPortName, rename] of uniqueRenames.entries()){
		let routeIndex = getAudioPortRouteIndex(audioPortName);
		let profileNames = rename.profileNames.map(function(profileName){
			return profileName.startsWith('output:') ? profileName.slice('output:'.length) : profileName;
		}).filter(function(profileName, index, values){
			return profileName.trim() != '' && values.indexOf(profileName) === index;
		});

		lines.push('\t{');
		lines.push('\t\tmatches = [');
		if(routeIndex != null){
			lines.push('\t\t\t{');
			lines.push('\t\t\t\tmedia.class = "Audio/Sink"');
			lines.push('\t\t\t\tdevice.api = "alsa"');
			lines.push('\t\t\t\tapi.alsa.path = ' + formatConfigString('hdmi:' + routeIndex));
			lines.push('\t\t\t}');
		}
		for(let profileName of profileNames){
			lines.push('\t\t\t{');
			lines.push('\t\t\t\tmedia.class = "Audio/Sink"');
			lines.push('\t\t\t\tdevice.api = "alsa"');
			lines.push('\t\t\t\tdevice.profile.name = ' + formatConfigString(profileName));
			lines.push('\t\t\t}');
		}
		lines.push('\t\t]');
		lines.push('\t\tactions = {');
		lines.push('\t\t\tupdate-props = {');
		lines.push('\t\t\t\tdevice.nick = ' + formatConfigString(rename.description));
		lines.push('\t\t\t\tdevice.description = ' + formatConfigString(rename.description));
		lines.push('\t\t\t\tdevice.profile.description = ' + formatConfigString(rename.description));
		lines.push('\t\t\t\tnode.nick = ' + formatConfigString(rename.description));
		lines.push('\t\t\t\tnode.description = ' + formatConfigString(rename.description));
		lines.push('\t\t\t\tport.description = ' + formatConfigString(rename.description));
		lines.push('\t\t\t}');
		lines.push('\t\t}');
		lines.push('\t}');
	}
	lines.push(']');
	return lines.join('\n') + '\n';
}


function buildManagedAcpProfileSet(baseSourceText, renames){
	let sourceText = baseSourceText;
	for(let rename of renames ?? []){
		if(typeof rename.audioPortName != 'string' || rename.audioPortName.trim() == '')
			continue;
		let managedPathName = getManagedAcpPathFileName(rename.audioPortName).replace(/\.conf$/, '');
		let escapedAudioPortName = rename.audioPortName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		let pattern = new RegExp('(^\\s*paths-output\\s*=\\s*)' + escapedAudioPortName + '(\\s*$)', 'gm');
		sourceText = sourceText.replace(pattern, '$1' + managedPathName + '$2');
	}
	return sourceText;
}


function buildManagedAcpPathConfig(baseSourceText, description){
	if(/^description\s*=.*$/m.test(baseSourceText))
		return baseSourceText.replace(/^description\s*=.*$/m, 'description = ' + description);
	return baseSourceText;
}


async function readManagedAudioRenameConfig(){
	try{
		return await fs.readFile(getManagedAudioRenameConfigPath(), 'utf8');
	}catch(err){
		if(err.code === 'ENOENT')
			return null;
		throw err;
	}
}


async function readFileIfExists(filePath){
	try{
		return await fs.readFile(filePath, 'utf8');
	}catch(err){
		if(err.code === 'ENOENT')
			return null;
		throw err;
	}
}


async function listManagedAcpPathFilePaths(){
	try{
		let entryNames = await fs.readdir(getAcpPathsDirPath());
		return entryNames.filter(function(entryName){
			return entryName.startsWith('kdisplay-manager-') && entryName.endsWith('.conf');
		}).map(function(entryName){
			return path.join(getAcpPathsDirPath(), entryName);
		});
	}catch(err){
		if(err.code === 'ENOENT')
			return [];
		throw err;
	}
}


async function getManagedAudioRenameFiles(renames){
	let normalizedRenames = [];
	let seenPorts = new Set();
	for(let rename of renames ?? []){
		if(typeof rename.audioPortName != 'string' || rename.audioPortName.trim() == '')
			continue;
		if(typeof rename.description != 'string' || rename.description.trim() == '')
			continue;
		if(seenPorts.has(rename.audioPortName))
			continue;
		seenPorts.add(rename.audioPortName);
		normalizedRenames.push(rename);
	}

	if(normalizedRenames.length === 0){
		return {
			wirePlumberConfigText: null,
			acpProfileSetText: null,
			pathFiles: []
		};
	}

	let baseProfileSetText = await fs.readFile(getSystemAcpProfileSetPath(), 'utf8');
	let pathFiles = [];
	for(let rename of normalizedRenames){
		let basePathText = await fs.readFile(getSystemAcpPathFilePath(rename.audioPortName), 'utf8');
		pathFiles.push({
			path: getManagedAcpPathFilePath(rename.audioPortName),
			text: buildManagedAcpPathConfig(basePathText, rename.description.trim())
		});
	}

	return {
		wirePlumberConfigText: buildWirePlumberAudioRenameConfig(normalizedRenames),
		acpProfileSetText: buildManagedAcpProfileSet(baseProfileSetText, normalizedRenames),
		pathFiles
	};
}



async function writeManagedAudioRenameConfig(sourceText){
	let directoryPath = getWirePlumberConfigDirPath();
	await fs.mkdir(directoryPath, {recursive: true});
	await fs.writeFile(getManagedAudioRenameConfigPath(), sourceText, 'utf8');
	return getManagedAudioRenameConfigPath();
}


async function removeManagedAudioRenameConfig(){
	try{
		await fs.unlink(getManagedAudioRenameConfigPath());
	}catch(err){
		if(err.code !== 'ENOENT')
			throw err;
	}
}


async function writeManagedAcpProfileSet(sourceText){
	await fs.mkdir(getAcpProfileSetsDirPath(), {recursive: true});
	await fs.writeFile(getManagedAcpProfileSetPath(), sourceText, 'utf8');
}


async function writeManagedAcpPathFile(filePath, sourceText){
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	await fs.writeFile(filePath, sourceText, 'utf8');
}


async function removeManagedAcpProfileSet(){
	try{
		await fs.unlink(getManagedAcpProfileSetPath());
	}catch(err){
		if(err.code !== 'ENOENT')
			throw err;
	}
}


async function removeManagedAcpPathFile(filePath){
	try{
		await fs.unlink(filePath);
	}catch(err){
		if(err.code !== 'ENOENT')
			throw err;
	}
}


function cleanupManagedAudioRenameConfigSync(){
	try{
		fsSync.rmSync(getManagedAudioRenameConfigPath(), {force: true});
		fsSync.rmSync(getManagedAcpProfileSetPath(), {force: true});
		if(fsSync.existsSync(getAcpPathsDirPath())){
			for(let entryName of fsSync.readdirSync(getAcpPathsDirPath())){
				if(!entryName.startsWith('kdisplay-manager-') || !entryName.endsWith('.conf'))
					continue;
				fsSync.rmSync(path.join(getAcpPathsDirPath(), entryName), {force: true});
			}
		}
	}catch(err){
		if(err.code !== 'ENOENT')
			throw err;
	}
}


function getCardProfileRecreateOperations(cards, renames, includeAllActiveCards = false){
	let operations = new Map();

	if(includeAllActiveCards){
		for(let card of cards){
			if(typeof card.name != 'string' || typeof card.active_profile != 'string' || card.active_profile == 'off')
				continue;
			operations.set(card.name, {
				cardName: card.name,
				activeProfile: card.active_profile,
				audioPortName: Object.keys(card.ports ?? {}).find(function(portName){
					return Array.isArray(card.ports?.[portName]?.profiles) && card.ports[portName].profiles.includes(card.active_profile);
				}) ?? null
			});
		}
		return [...operations.values()];
	}

	for(let rename of renames ?? []){
		if(typeof rename.audioPortName != 'string' || rename.sinkName == null)
			continue;

		for(let card of cards){
			if(typeof card.name != 'string' || typeof card.active_profile != 'string' || card.active_profile == 'off')
				continue;
			if(card.ports?.[rename.audioPortName] == null)
				continue;
			operations.set(card.name, {
				cardName: card.name,
				activeProfile: card.active_profile,
				audioPortName: rename.audioPortName
			});
			break;
		}
	}

	return [...operations.values()];
}


function sleep(delayMs){
	return new Promise(function(resolve){
		setTimeout(resolve, delayMs);
	});
}


function getCardForAudioRename(cards, operation){
	for(let card of cards){
		if(typeof card.name != 'string' || typeof card.active_profile != 'string')
			continue;
		if(operation.audioPortName != null && card.ports?.[operation.audioPortName] != null)
			return card;
		if(card.name === operation.cardName)
			return card;
	}
	return null;
}


async function recreateAudioCardProfile(operation){
	for(let attempt = 0; attempt < 10; attempt++){
		let cards = await runPactlJson(['list', 'cards']);
		let card = getCardForAudioRename(cards, operation);
		if(card != null){
			await execFileAsync('pactl', ['set-card-profile', card.name, 'off'], {
				encoding: 'utf8'
			});
			await execFileAsync('pactl', ['set-card-profile', card.name, operation.activeProfile], {
				encoding: 'utf8'
			});
			return;
		}

		await sleep(300);
	}

	throw new Error('Could not resolve PulseAudio card after WirePlumber restart for ' + (operation.audioPortName ?? operation.cardName));
}


async function getAudioRenameOperations(renames){
	let managedFiles = await getManagedAudioRenameFiles(renames);
	let desiredFiles = new Map();
	if(managedFiles.wirePlumberConfigText != null)
		desiredFiles.set(getManagedAudioRenameConfigPath(), managedFiles.wirePlumberConfigText);
	if(managedFiles.acpProfileSetText != null)
		desiredFiles.set(getManagedAcpProfileSetPath(), managedFiles.acpProfileSetText);
	for(let pathFile of managedFiles.pathFiles)
		desiredFiles.set(pathFile.path, pathFile.text);

	let currentFiles = new Map();
	let managedPaths = [
		getManagedAudioRenameConfigPath(),
		getManagedAcpProfileSetPath(),
		...await listManagedAcpPathFilePaths(),
		...desiredFiles.keys()
	];
	for(let filePath of new Set(managedPaths))
		currentFiles.set(filePath, await readFileIfExists(filePath));

	let filesToWrite = [];
	for(let [filePath, sourceText] of desiredFiles.entries()){
		if(currentFiles.get(filePath) !== sourceText)
			filesToWrite.push({path: filePath, text: sourceText});
	}
	let filesToRemove = [...currentFiles.keys()].filter(function(filePath){
		return currentFiles.get(filePath) != null && !desiredFiles.has(filePath);
	});
	let needsConfigUpdate = filesToWrite.length > 0 || filesToRemove.length > 0;
	let cards = await runPactlJson(['list', 'cards']);
	let recreateProfiles = getCardProfileRecreateOperations(cards, renames, desiredFiles.size === 0 && filesToRemove.length > 0);
	return {
		configPath: getManagedAudioRenameConfigPath(),
		nextSourceText: managedFiles.wirePlumberConfigText,
		needsConfigUpdate,
		filesToWrite,
		filesToRemove,
		restartCommand: ['systemctl', '--user', 'restart', 'wireplumber.service'],
		recreateProfiles,
		recreateCommands: recreateProfiles.flatMap(function(operation){
			return [
				['pactl', 'set-card-profile', operation.cardName, 'off'],
				['pactl', 'set-card-profile', operation.cardName, operation.activeProfile]
			];
		})
	};
}


async function applyAudioRenameOperation(operation){
	if(!operation.needsConfigUpdate)
		return;

	for(let filePath of operation.filesToRemove){
		if(filePath === getManagedAudioRenameConfigPath())
			await removeManagedAudioRenameConfig();
		else if(filePath === getManagedAcpProfileSetPath())
			await removeManagedAcpProfileSet();
		else
			await removeManagedAcpPathFile(filePath);
	}
	for(let file of operation.filesToWrite){
		if(file.path === getManagedAudioRenameConfigPath())
			await writeManagedAudioRenameConfig(file.text);
		else if(file.path === getManagedAcpProfileSetPath())
			await writeManagedAcpProfileSet(file.text);
		else
			await writeManagedAcpPathFile(file.path, file.text);
	}

	await execFileAsync(operation.restartCommand[0], operation.restartCommand.slice(1), {
		encoding: 'utf8'
	});

	for(let profileOperation of operation.recreateProfiles)
		await recreateAudioCardProfile(profileOperation);
}


async function runApplyCommand(name, dryRun, options = {}){
	await ensureDisplaysLoaded(options);
	let plan = await resolveApplyPlan(name, options);
	let command = ['gdctl', ...plan.gdctlArgs];
	let shouldApplyDisplay = options.applyDisplay !== false;
	let shouldApplyTouch = options.applyTouch !== false;
	let shouldApplyAudio = options.applyAudio !== false;
	console.log('applying configuration:', plan.configName);

	if(shouldApplyDisplay && plan.gdctlArgs.length > 0)
		console.log(formatCommand(command));

	let helperBinaryPath = null;
	if(shouldApplyTouch && plan.touchMappings.length > 0)
		helperBinaryPath = await ensureTouchHelperBuilt();
	let audioRenameOperations = shouldApplyAudio ? await getAudioRenameOperations(plan.audioRenames ?? []) : [];
	for(let warning of plan.warnings)
		console.warn(warning);
	for(let mapping of plan.touchMappings){
		console.log(formatCommand(formatTouchMapperCommand(helperBinaryPath, mapping)));
	}
	if(shouldApplyAudio && audioRenameOperations.needsConfigUpdate){
		for(let filePath of audioRenameOperations.filesToRemove)
			console.log(formatManagedAudioRenameAction('remove-managed-config', filePath));
		for(let file of audioRenameOperations.filesToWrite)
			console.log(formatManagedAudioRenameAction('write-managed-config', file.path));
		console.log(formatCommand(audioRenameOperations.restartCommand));
		for(let command of audioRenameOperations.recreateCommands)
			console.log(formatCommand(command));
	}

	if(dryRun)
		return plan;

	if(shouldApplyDisplay && plan.gdctlArgs.length > 0)
		await runGdctl(plan.gdctlArgs);

	if(shouldApplyTouch){
		await startTouchMappers(plan.touchMappings, options.stateDir ?? getStateDirPath());
		if(plan.touchMappings.length === 0)
			await stopTouchMappers(options.stateDir ?? getStateDirPath());
	}

	if(shouldApplyAudio){
		await applyAudioRenameOperation(audioRenameOperations);
	}

	return plan;
}


async function runGdctl(args){
	let result = await execFileAsync('gdctl', args, {
		encoding: 'utf8'
	});
	return result.stdout;
}


async function getDisplayState(){
	let sourceText = await runGdctl(['show', '-mpv']);
	return parseGdctlShow(sourceText);
}


async function ensureDisplaysLoaded(options = {}){
	if(options.configDir != null || displays == null)
		await loadDisplays(options.configDir);
	return displays;
}


function createArgumentParser(){
	let parser = new ArgumentParser({
		prog: 'display-manager.js',
		description: 'Inspect display state and apply saved display configs.'
	});

	function addCommonOptions(targetParser){
		targetParser.add_argument('--config-dir', {
			help: 'read display configs from this directory'
		});
		targetParser.add_argument('--state-dir', {
			help: 'read and write state in this directory'
		});
	}

	addCommonOptions(parser);

	let subparsers = parser.add_subparsers({
		dest: 'command'
	});

	let listConfigsParser = subparsers.add_parser('list-configs', {
		help: 'list saved display configs'
	});
	addCommonOptions(listConfigsParser);
	listConfigsParser.add_argument('--order', {
		choices: ['recent', 'config'],
		default: 'config',
		help: 'order configs by recent use or config file order'
	});
	listConfigsParser.add_argument('--json', {
		action: 'store_true',
		help: 'print configs as JSON'
	});
	listConfigsParser.add_argument('--applicable', {
		action: 'store_true',
		help: 'only include configs that match connected displays'
	});

	let listMonitorsParser = subparsers.add_parser('list-monitors', {
		help: 'list connected monitors'
	});
	addCommonOptions(listMonitorsParser);
	listMonitorsParser.add_argument('--json', {
		action: 'store_true',
		help: 'print monitors as JSON'
	});

	let listTouchDevicesParser = subparsers.add_parser('list-touchscreens', {
		help: 'list connected touch-capable input devices'
	});
	addCommonOptions(listTouchDevicesParser);
	listTouchDevicesParser.add_argument('--json', {
		action: 'store_true',
		help: 'print touch devices as JSON'
	});

	let listAudioParser = subparsers.add_parser('list-audio', {
		help: 'list resolved monitor audio mappings'
	});
	addCommonOptions(listAudioParser);
	listAudioParser.add_argument('config_name', {
		nargs: '?',
		help: 'display config name'
	});
	listAudioParser.add_argument('--json', {
		action: 'store_true',
		help: 'print audio mappings as JSON'
	});

	let applyParser = subparsers.add_parser('apply', {
		help: 'apply a saved display config'
	});
	addCommonOptions(applyParser);
	applyParser.add_argument('config_name', {
		nargs: '?',
		help: 'display config name'
	});
	applyParser.add_argument('--dry-run', {
		action: 'store_true',
		help: 'print the gdctl command without applying it'
	});

	return parser;
}


function parseCommandLine(args){
	let parsed = createArgumentParser().parse_args(args);
	return {
		options: {
			configDir: getConfigDirPath(parsed.config_dir),
			stateDir: getStateDirPath(parsed.state_dir)
		},
		command: parsed.command,
		configName: parsed.config_name,
		isDryRun: parsed.dry_run === true,
		useJson: parsed.json === true,
		useApplicable: parsed.applicable === true,
		configOrder: parsed.order ?? 'config'
	};
}


function orderConfigNames(configs, recentNames, order){
	let names = Object.keys(configs);
	if(order !== 'recent')
		return names;

	let ordered = [];
	let seen = new Set();
	for(let name of recentNames){
		if(configs[name] == null || seen.has(name))
			continue;
		seen.add(name);
		ordered.push(name);
	}
	for(let name of names){
		if(seen.has(name))
			continue;
		ordered.push(name);
	}
	return ordered;
}


function printMonitorSummary(monitors){
	for(let monitor of monitors){
		let configuredNames = monitor.configuredNames.length > 0 ? monitor.configuredNames.join(',') : '-';
		console.log([monitor.port, monitor.vendor ?? '-', monitor.product ?? '-', monitor.serial ?? '-', configuredNames].join('\t'));
	}
}


function printTouchDeviceSummary(devices){
	for(let device of devices){
		console.log('name:\t' + (device.name ?? '-'));
		console.log('event:\t' + device.eventPath);
		console.log('by-id:\t' + (device.byIdPath ?? '-'));
		console.log('vendor/product:\t' + ((device.vendorId ?? '-') + ':' + (device.productId ?? '-')));
		console.log('serial:\t' + (device.serial ?? '-'));
		console.log('uniq:\t' + (device.uniq ?? '-'));
		console.log('path:\t' + (device.path ?? '-'));
		console.log('size-mm:\t' + ((device.widthMm ?? '-') + 'x' + (device.heightMm ?? '-')));
		console.log('');
	}
}


function printAudioRenameSummary(plan){
	printTable(
		['index', 'name', 'description', 'port', 'product', 'monitor', 'monitor-port', 'renameTo'],
		plan.audioMappings.map(function(mapping){
			return [
				mapping.sinkIndex,
				mapping.sinkName,
				mapping.sinkDescription,
				mapping.audioPortName,
				mapping.product,
				mapping.logicalMonitorName,
				mapping.monitorPort,
				mapping.renameDescription
			];
		})
	);
	if(plan.audioMappings.length === 0 && plan.warnings.length === 0)
		console.log('(no audio sinks)');
}


function formatAudioMappingsForJson(plan){
	return plan.audioMappings.map(function(mapping){
		return {
			index: mapping.sinkIndex,
			name: mapping.sinkName,
			description: mapping.sinkDescription,
			port: mapping.audioPortName,
			product: mapping.product,
			monitor: mapping.logicalMonitorName,
			'monitor-port': mapping.monitorPort,
			renameTo: mapping.renameDescription
		};
	});
}


function printTable(headers, rows){
	let stringRows = rows.map(function(row){
		return row.map(function(value){
			if(value == null || value === '')
				return '-';
			return '' + value;
		});
	});
	let widths = headers.map(function(header, index){
		let rowWidth = stringRows.reduce(function(maxWidth, row){
			return Math.max(maxWidth, row[index]?.length ?? 0);
		}, 0);
		return Math.max(header.length, rowWidth);
	});

	let formatRow = function(row){
		return row.map(function(cell, index){
			return cell.padEnd(widths[index]);
		}).join('  ');
	};

	console.log(formatRow(headers));
	for(let row of stringRows)
		console.log(formatRow(row));
}



async function runCommand(commandLine){
	let {options, command, configName, isDryRun, useJson, useApplicable, configOrder} = commandLine;

	if(command == 'list-configs'){
		await ensureDisplaysLoaded(options);
		let configs = listConfigs();
		if(useApplicable)
			configs = filterAvailableConfigs(configs, await getDisplayState());
		let recentConfigNames = configOrder === 'recent' ? await readStateFile(options.stateDir) : [];
		let orderedNames = orderConfigNames(configs, recentConfigNames, configOrder);

		if(!useJson){
			for(let name of orderedNames)
				console.log(name);
			return;
		}

		let orderedConfigs = {};
		for(let name of orderedNames)
			orderedConfigs[name] = configs[name];
		console.log(JSON.stringify(orderedConfigs, null, '\t'));
		return;
	}

	if(command == 'list-monitors'){
		try{
			await ensureDisplaysLoaded(options);
		}catch(err){
			if(!(err instanceof Error) || !err.message.startsWith('Could not find display manager config file in '))
				throw err;
		}
		let state = await getDisplayState();
		let monitors = state.monitors.map(function(monitor){
			return {
				...monitor,
				configuredNames: getConfiguredMonitorNamesForMonitor(monitor)
			};
		});
		if(useJson){
			console.log(JSON.stringify(monitors, null, '\t'));
			return;
		}
		printMonitorSummary(monitors);
		return;
	}

	if(command == 'list-touchscreens'){
		let devices = await listTouchDevices();
		if(useJson){
			console.log(JSON.stringify(devices, null, '\t'));
			return;
		}
		printTouchDeviceSummary(devices);
		return;
	}

	if(command == 'list-audio'){
		await ensureDisplaysLoaded(options);
		let plan = await getAudioRenamePlan(configName, options);
		if(useJson){
			console.log(JSON.stringify(formatAudioMappingsForJson(plan), null, '\t'));
			return;
		}
		printAudioRenameSummary(plan);
		return;
	}

	if(command == 'apply'){
		await ensureDisplaysLoaded(options);
		let plan = await runApplyCommand(configName, isDryRun, options);
		if(!isDryRun)
			await noteRecentConfig(plan.configName, options.stateDir);
		return;
	}

	await ensureDisplaysLoaded(options);
	let state = await getDisplayState();
	console.log(JSON.stringify(state, null, '\t'));
}


async function main(){
	let commandLine = parseCommandLine(process.argv.slice(2));
	await runCommand(commandLine);
}


async function runCli(args){
	let commandLine = parseCommandLine(args);
	await runCommand(commandLine);
}


if(process.argv[1] != null && path.resolve(process.argv[1]) == fileURLToPath(import.meta.url)){
	main().catch(function(err){
		console.error(err);
		process.exitCode = 1;
	});
}


export {applyConfig, buildSetArgs, chooseConfigName, cleanupManagedAudioRenameConfigSync, filterAvailableConfigs, filterMostSpecificConfigNames, formatCommand, getConfigMonitorNames, getDisplayState, listConfigs, loadDisplays, matchesMonitorIdentity, parseGdctlShow, parseIndentedInfoTree, resolveApplyPlan, resolveConfig, resolveMonitorName, runApplyCommand, runCli, runGdctl, selectConfigForDisplayState};
