import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {xdgConfig, xdgData, xdgState} from 'xdg-basedir';


function getDefaultConfigHome(){
	return xdgConfig ?? path.join(os.homedir(), '.config');
}


function getDefaultStateHome(){
	return xdgState ?? xdgData ?? path.join(os.homedir(), '.local', 'state');
}


function expandHome(filePath){
	if(filePath == null)
		return filePath;

	if(filePath == '~')
		return os.homedir();

	if(filePath.startsWith('~/'))
		return path.join(os.homedir(), filePath.slice(2));

	return filePath;
}


function getDefaultConfigDirPath(){
	return path.join(getDefaultConfigHome(), 'kdisplay-manager');
}


function getDefaultStateDirPath(){
	return path.join(getDefaultStateHome(), 'kdisplay-manager');
}


function getConfigDirPath(configDir){
	return path.resolve(expandHome(configDir ?? getDefaultConfigDirPath()));
}


function getStateDirPath(stateDir){
	return path.resolve(expandHome(stateDir ?? getDefaultStateDirPath()));
}


function getConfigCandidates(configDir){
	let resolvedDirPath = getConfigDirPath(configDir);
	return [
		path.join(resolvedDirPath, 'kdisplay-manager.json'),
		path.join(resolvedDirPath, 'kdisplay-manager.js')
	];
}


async function getConfigFilePath(configDir){
	for(let filePath of getConfigCandidates(configDir)){
		try{
			await fsp.access(filePath, fs.constants.F_OK);
			return filePath;
		}catch(err){
			if(err.code != 'ENOENT')
				throw err;
		}
	}

	throw new Error('Could not find display manager config file in ' + getConfigDirPath(configDir));
}


function getStateFilePath(stateDir){
	return path.join(getStateDirPath(stateDir), 'recent-configs.txt');
}


function isPlainObject(value){
	return value != null && typeof value == 'object' && !Array.isArray(value);
}


async function loadDisplayConfig(configDir){
	let resolvedPath = await getConfigFilePath(configDir);
	let config;

	if(resolvedPath.endsWith('.json')){
		let sourceText = await fsp.readFile(resolvedPath, 'utf8');
		config = JSON.parse(sourceText);
	}else if(resolvedPath.endsWith('.js')){
		let imported = await import(pathToFileURL(resolvedPath).href + '?t=' + Date.now());
		config = imported.default;
	}else{
		throw new Error('Unsupported display manager config file type: ' + resolvedPath);
	}

	if(!isPlainObject(config))
		throw new Error('Display manager config must export a plain object: ' + resolvedPath);
	if(!isPlainObject(config.monitors))
		throw new Error('Display manager config must define a monitors object: ' + resolvedPath);
	if(!isPlainObject(config.configs))
		throw new Error('Display manager config must define a configs object: ' + resolvedPath);

	return config;
}


function getApplyOnConfigChange(config){
	return config['apply-on-config-change'] === true;
}


function getSelectionStrategy(config){
	let strategy = config['selection-strategy'];
	if(strategy == null)
		return 'most-monitors';
	if(strategy === 'most-monitors' || strategy === 'recent' || strategy === 'configuration-order')
		return strategy;
	throw new Error('Unsupported selection strategy: ' + strategy);
}


async function readStateFile(stateDir){
	let resolvedPath = getStateFilePath(stateDir);
	let sourceText;

	try{
		sourceText = await fsp.readFile(resolvedPath, 'utf8');
	}catch(err){
		if(err.code == 'ENOENT')
			return [];
		throw err;
	}

	let seen = new Set();
	let names = [];
	for(let line of sourceText.split(/\r?\n/)){
		let name = line.trim();
		if(name == '' || seen.has(name))
			continue;

		seen.add(name);
		names.push(name);
	}

	return names;
}


async function writeStateFile(stateDir, names){
	let resolvedPath = getStateFilePath(stateDir);
	let directoryPath = path.dirname(resolvedPath);
	await fsp.mkdir(directoryPath, {recursive: true});

	let normalizedNames = [];
	let seen = new Set();
	for(let name of names){
		if(typeof name != 'string')
			continue;

		name = name.trim();
		if(name == '' || seen.has(name))
			continue;

		seen.add(name);
		normalizedNames.push(name);
	}

	let tempPath = resolvedPath + '.tmp-' + process.pid;
	let sourceText = normalizedNames.join('\n');
	if(sourceText != '')
		sourceText += '\n';

	await fsp.writeFile(tempPath, sourceText, 'utf8');
	await fsp.rename(tempPath, resolvedPath);
}


async function noteRecentConfig(name, stateDir){
	let names = await readStateFile(stateDir);
	names = [name, ...names.filter(function(entry){
		return entry !== name;
	})];
	await writeStateFile(stateDir, names);
	return names;
}


function findExistingWatchPath(targetPath){
	let currentPath = path.resolve(targetPath);
	while(!fs.existsSync(currentPath)){
		let parentPath = path.dirname(currentPath);
		if(parentPath == currentPath)
			break;
		currentPath = parentPath;
	}
	return currentPath;
}


export {
	expandHome,
	findExistingWatchPath,
	getApplyOnConfigChange,
	getConfigCandidates,
	getConfigDirPath,
	getConfigFilePath,
	getDefaultConfigDirPath,
	getDefaultStateDirPath,
	getSelectionStrategy,
	getStateDirPath,
	getStateFilePath,
	loadDisplayConfig,
	noteRecentConfig,
	readStateFile,
	writeStateFile
};
