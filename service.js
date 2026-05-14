import argparse from 'argparse';
import dbus from 'dbus-next';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	filterAvailableConfigs,
	getDisplayState,
	getConfigMonitorNames,
	listConfigs,
	loadDisplays,
	matchesMonitorIdentity,
	runApplyCommand
} from './display-manager.js';
import {
	findExistingWatchPath,
	getApplyOnConfigChange,
	getConfigCandidates,
	getConfigDirPath,
	getConfigFilePath,
	getSelectionStrategy,
	getStateDirPath,
	getStateFilePath,
	loadDisplayConfig,
	readStateFile
} from './runtime.js';


let DISPLAY_CONFIG_SERVICE = 'org.gnome.Mutter.DisplayConfig';
let DISPLAY_CONFIG_PATH = '/org/gnome/Mutter/DisplayConfig';
let DISPLAY_CONFIG_INTERFACE = 'org.gnome.Mutter.DisplayConfig';
let DEFAULT_DEBOUNCE_MS = 500;
let DEFAULT_SELF_APPLY_COOLDOWN_MS = 2000;


let {ArgumentParser} = argparse;


function parseArgs(args){
	let parser = new ArgumentParser({
		prog: 'service.js',
		description: 'Watch GNOME display changes and apply saved display configs.'
	});
	parser.add_argument('--apply-on-start', {
		action: 'store_true',
		help: 'apply the selected config when the service starts'
	});
	parser.add_argument('--config-dir', {
		help: 'read display configs from this directory'
	});
	parser.add_argument('--state-dir', {
		help: 'read and write state in this directory'
	});

	let parsed = parser.parse_args(args);
	return {
		applyOnStart: parsed.apply_on_start === true,
		configDir: getConfigDirPath(parsed.config_dir),
		stateDir: getStateDirPath(parsed.state_dir)
	};
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


function getConfigMonitorCount(config){
	return getConfigMonitorNames(config).length;
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


class DisplayManagerService {
	constructor(options){
		this.options = options;
		this.bus = null;
		this.displayConfig = null;
		this.displayConfigFile = null;
		this.configWatcher = null;
		this.configWatchPath = null;
		this.stateWatcher = null;
		this.stateWatchPath = null;
		this.displayTimer = null;
		this.configTimer = null;
		this.stateTimer = null;
		this.selfApplyUntil = 0;
		this.stopped = false;
	}


	async start(){
		await this.reloadConfig('startup');
		this.watchConfigFile();
		this.watchStateFile();

		this.bus = dbus.sessionBus();
		let proxyObject = await this.bus.getProxyObject(DISPLAY_CONFIG_SERVICE, DISPLAY_CONFIG_PATH);
		let displayConfigInterface = proxyObject.getInterface(DISPLAY_CONFIG_INTERFACE);
		displayConfigInterface.on('MonitorsChanged', this.onMonitorsChanged.bind(this));

		if(this.bus != null && typeof this.bus.on == 'function'){
			this.bus.on('error', function(err){
				console.error('[display-manager service] D-Bus connection error:', err);
			});
		}

		console.log('[display-manager service] listening for display changes');
		console.log('[display-manager service] config dir:', this.options.configDir);
		console.log('[display-manager service] config file:', this.displayConfigFile);
		console.log('[display-manager service] state dir:', this.options.stateDir);
		console.log('[display-manager service] state file:', getStateFilePath(this.options.stateDir));

		if(this.options.applyOnStart)
			await this.reconcile('startup');
	}


	stop(){
		this.stopped = true;
		if(this.displayTimer != null)
			clearTimeout(this.displayTimer);
		if(this.configTimer != null)
			clearTimeout(this.configTimer);
		if(this.stateTimer != null)
			clearTimeout(this.stateTimer);
		if(this.configWatcher != null)
			this.configWatcher.close();
		if(this.stateWatcher != null)
			this.stateWatcher.close();
		if(this.bus != null)
			this.bus.disconnect();
	}


	async reloadConfig(reason){
		this.displayConfigFile = await getConfigFilePath(this.options.configDir);
		this.displayConfig = await loadDisplayConfig(this.options.configDir);
		await loadDisplays(this.options.configDir);
		console.log('[display-manager service] loaded config for', reason);
	}


	watchConfigFile(){
		this.configWatchPath = findExistingWatchPath(this.options.configDir);
		this.configWatcher = fs.watch(this.configWatchPath, {persistent: true}, this.onConfigWatchEvent.bind(this));
	}


	watchStateFile(){
		this.stateWatchPath = findExistingWatchPath(this.options.stateDir);
		this.stateWatcher = fs.watch(this.stateWatchPath, {persistent: true}, this.onStateWatchEvent.bind(this));
	}


	onConfigWatchEvent(eventType, fileName){
		if(fileName != null && this.configWatchPath == this.options.configDir){
			let candidateNames = new Set(getConfigCandidates(this.options.configDir).map(function(filePath){
				return path.basename(filePath);
			}));
			if(!candidateNames.has(fileName))
				return;
		}else if(fileName != null && this.configWatchPath == path.dirname(this.options.configDir)){
			if(fileName !== path.basename(this.options.configDir))
				return;
		}

		if(this.configTimer != null)
			clearTimeout(this.configTimer);

		this.configTimer = setTimeout(function(){
			this.handleConfigFileChange().catch(function(err){
				console.error('[display-manager service] config reload failed:', err);
			});
		}.bind(this), DEFAULT_DEBOUNCE_MS);
	}


	async handleConfigFileChange(){
		await this.reloadConfig('config change');

		let nextWatchPath = findExistingWatchPath(this.options.configDir);
		if(this.configWatchPath !== nextWatchPath){
			this.configWatcher.close();
			this.watchConfigFile();
		}

		if(getApplyOnConfigChange(this.displayConfig))
			await this.reconcile('config change');
	}


	onStateWatchEvent(eventType, fileName){
		let stateFileName = path.basename(getStateFilePath(this.options.stateDir));
		if(fileName != null && this.stateWatchPath == this.options.stateDir){
			if(fileName !== stateFileName)
				return;
		}else if(fileName != null && this.stateWatchPath == path.dirname(this.options.stateDir)){
			if(fileName !== path.basename(this.options.stateDir))
				return;
		}

		if(this.stateTimer != null)
			clearTimeout(this.stateTimer);

		this.stateTimer = setTimeout(function(){
			this.handleStateFileChange().catch(function(err){
				console.error('[display-manager service] state reload failed:', err);
			});
		}.bind(this), DEFAULT_DEBOUNCE_MS);
	}


	async handleStateFileChange(){
		let nextWatchPath = findExistingWatchPath(this.options.stateDir);
		if(this.stateWatchPath !== nextWatchPath){
			this.stateWatcher.close();
			this.watchStateFile();
		}

		await this.reconcile('state change');
	}


	onMonitorsChanged(){
		if(Date.now() < this.selfApplyUntil)
			return;

		if(this.displayTimer != null)
			clearTimeout(this.displayTimer);

		this.displayTimer = setTimeout(function(){
			this.reconcile('display change').catch(function(err){
				console.error('[display-manager service] display reconciliation failed:', err);
			});
		}.bind(this), DEFAULT_DEBOUNCE_MS);
	}


	async reconcile(reason){
		let displayState = await getDisplayState();
		let configs = listConfigs();
		let availableConfigs = filterAvailableConfigs(configs, displayState);
		let availableConfigNames = Object.keys(availableConfigs);
		let selectionStrategy = getSelectionStrategy(this.displayConfig);
		let knownConfigNames = new Set(Object.keys(configs));

		if(availableConfigNames.length == 0){
			console.log('[display-manager service] no applicable config for', reason);
			return;
		}

		if(selectionStrategy === 'most-monitors')
			availableConfigNames = filterMostSpecificConfigNames(configs, availableConfigNames);

		let recentConfigNames = await readStateFile(this.options.stateDir);
		for(let name of recentConfigNames){
			if(!knownConfigNames.has(name))
				console.warn('[display-manager service] ignoring unknown recent config:', name);
		}

		let configName = chooseConfigName(availableConfigNames, recentConfigNames, selectionStrategy);
		if(configName == null){
			console.log('[display-manager service] no config selected for', reason);
			return;
		}

		console.log('[display-manager service] applying', configName, 'for', reason);
		this.selfApplyUntil = Date.now() + DEFAULT_SELF_APPLY_COOLDOWN_MS;
		await runApplyCommand(configName, false, {
			configDir: this.options.configDir
		});
	}
}


async function main(){
	let options = parseArgs(process.argv.slice(2));
	let service = new DisplayManagerService(options);

	for(let signalName of ['SIGINT', 'SIGTERM']){
		process.on(signalName, function(){
			service.stop();
		});
	}

	await service.start();
}


async function runCli(args){
	let options = parseArgs(args);
	let service = new DisplayManagerService(options);

	for(let signalName of ['SIGINT', 'SIGTERM']){
		process.on(signalName, function(){
			service.stop();
		});
	}

	await service.start();
}


if(process.argv[1] != null && path.resolve(process.argv[1]) == fileURLToPath(import.meta.url)){
	main().catch(function(err){
		console.error(err);
		process.exitCode = 1;
	});
}


export {runCli};
