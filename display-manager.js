import argparse from 'argparse';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {getConfigDirPath, getStateDirPath, loadDisplayConfig, noteRecentConfig} from './runtime.js';


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


function getConfigMonitorNames(config){
	let names = [];
	for(let entry of getConfigMonitorEntries(config)){
		if(entry.config.enable === false)
			continue;

		for(let name of entry.config.monitors ?? []){
			if(!names.includes(name))
				names.push(name);
		}
	}
	return names;
}


function isConfigAvailable(config, displayState){
	try{
		for(let name of getConfigMonitorNames(config))
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
	entries = normalizePrimary(sortLogicalMonitorEntries(entries));

	let resolvedEntries = [];
	let resolvedEntriesByName = {};

	for(let entry of entries){
		let connectedMonitors = entry.config.monitors.map(function(name){
			return resolveMonitorName(name, displayState);
		});

		if(connectedMonitors[0] == null)
			throw new Error('Logical monitor has no monitors: ' + entry.name);

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

	return normalizeLogicalMonitorPositions(resolvedEntries);
}


function normalizePrimary(entries){
	let primaryEntries = entries.filter(function(entry){
		return entry.config.primary === true;
	});

	if(primaryEntries.length > 1)
		throw new Error('Config declares multiple primary logical monitors');

	if(primaryEntries.length == 0)
		throw new Error('Config declares no primary logical monitor');

	return entries;
}


function buildSetArgs(config, displayState){
	let args = ['set'];
	let entries = resolveLogicalMonitorEntries(config, displayState);

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


async function runApplyCommand(name, dryRun, options = {}){
	await ensureDisplaysLoaded(options);
	let args = await applyConfig(name);
	let command = ['gdctl', ...args];

	console.log(formatCommand(command));

	if(!dryRun)
		await runGdctl(args);

	return args;
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
	listConfigsParser.add_argument('--json', {
		action: 'store_true',
		help: 'print configs as JSON'
	});
	listConfigsParser.add_argument('--available', {
		action: 'store_true',
		help: 'only include configs that match connected displays'
	});

	let applyParser = subparsers.add_parser('apply', {
		help: 'apply a saved display config'
	});
	addCommonOptions(applyParser);
	applyParser.add_argument('config_name', {
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
		useAvailable: parsed.available === true
	};
}



async function runCommand(commandLine){
	let {options, command, configName, isDryRun, useJson, useAvailable} = commandLine;
	await ensureDisplaysLoaded(options);

	if(command == 'list-configs'){
		let configs = listConfigs();
		if(useAvailable)
			configs = filterAvailableConfigs(configs, await getDisplayState());

		if(!useJson){
			for(let name of Object.keys(configs))
				console.log(name);
			return;
		}

		console.log(JSON.stringify(configs, null, '\t'));
		return;
	}

	if(command == 'apply'){
		await runApplyCommand(configName, isDryRun, options);
		if(!isDryRun)
			await noteRecentConfig(configName, options.stateDir);
		return;
	}

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


export {applyConfig, buildSetArgs, filterAvailableConfigs, formatCommand, getConfigMonitorNames, getDisplayState, listConfigs, loadDisplays, matchesMonitorIdentity, parseGdctlShow, parseIndentedInfoTree, resolveConfig, resolveMonitorName, runApplyCommand, runCli, runGdctl};
