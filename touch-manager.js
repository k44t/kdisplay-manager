import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';


let execFileAsync = promisify(execFile);
let packageDirPath = path.dirname(fileURLToPath(import.meta.url));
let helperSourcePath = path.join(packageDirPath, 'native', 'uinput-mapper.c');
let helperBinaryPath = path.join(packageDirPath, 'native', 'uinput-mapper');


function parseEnvLines(sourceText){
	let values = {};
	for(let line of sourceText.split(/\r?\n/)){
		if(line.trim() == '')
			continue;

		let index = line.indexOf('=');
		if(index < 0)
			continue;

		values[line.slice(0, index)] = line.slice(index + 1);
	}
	return values;
}


function normalizeHexId(value){
	if(value == null)
		return null;
	value = String(value).trim().toLowerCase();
	value = value.replace(/^0x/, '');
	return value == '' ? null : value;
}


function splitDevlinks(value){
	if(typeof value != 'string' || value.trim() == '')
		return [];
	return value.trim().split(/\s+/);
}


function isTouchDevice(properties){
	if(properties.ID_INPUT_TOUCHSCREEN === '1')
		return true;
	if(properties.ID_INPUT_TABLET === '1')
		return true;

	let name = [properties.NAME, properties.ID_MODEL, properties.HID_NAME].filter(Boolean).join(' ');
	return /touch\s*screen/i.test(name);
}


function buildTouchDevice(properties, eventPath){
	if(!isTouchDevice(properties))
		return null;

	let devlinks = splitDevlinks(properties.DEVLINKS);
	return {
		eventPath,
		name: properties.NAME ?? null,
		hidName: properties.HID_NAME ?? null,
		uniq: properties.UNIQ ?? properties.HID_UNIQ ?? null,
		vendorId: normalizeHexId(properties.ID_VENDOR_ID ?? properties.ID_USB_VENDOR_ID),
		productId: normalizeHexId(properties.ID_MODEL_ID ?? properties.ID_USB_MODEL_ID),
		vendor: properties.ID_VENDOR ?? properties.ID_USB_VENDOR ?? null,
		product: properties.ID_MODEL ?? properties.ID_USB_MODEL ?? null,
		serial: properties.ID_SERIAL_SHORT ?? properties.ID_USB_SERIAL_SHORT ?? properties.ID_SERIAL ?? properties.ID_USB_SERIAL ?? null,
		path: properties.ID_PATH ?? null,
		pathTag: properties.ID_PATH_TAG ?? null,
		interfaceNumber: properties.ID_USB_INTERFACE_NUM ?? null,
		isTouchscreen: properties.ID_INPUT_TOUCHSCREEN === '1',
		isTablet: properties.ID_INPUT_TABLET === '1',
		isMouse: properties.ID_INPUT_MOUSE === '1',
		isKeyboard: properties.ID_INPUT_KEYBOARD === '1',
		widthMm: properties.ID_INPUT_WIDTH_MM ?? null,
		heightMm: properties.ID_INPUT_HEIGHT_MM ?? null,
		devlinks,
		byIdPath: devlinks.find(function(entry){
			return entry.startsWith('/dev/input/by-id/');
		}) ?? null,
		byPathPath: devlinks.find(function(entry){
			return entry.startsWith('/dev/input/by-path/');
		}) ?? null,
		properties
	};
}


async function getUdevProperties(devicePath){
	let result = await execFileAsync('udevadm', ['info', '--query=property', '--name=' + devicePath], {
		encoding: 'utf8'
	});
	return parseEnvLines(result.stdout);
}


async function listTouchDevices(){
	let entryNames = await fsp.readdir('/dev/input');
	let eventNames = entryNames.filter(function(name){
		return /^event\d+$/.test(name);
	}).sort(function(a, b){
		return a.localeCompare(b, undefined, {numeric: true});
	});

	let devices = [];
	for(let eventName of eventNames){
		let eventPath = path.join('/dev/input', eventName);
		let properties;
		try{
			properties = await getUdevProperties(eventPath);
		}catch(err){
			if(err.code === 'ENOENT')
				continue;
			throw err;
		}

		let device = buildTouchDevice(properties, eventPath);
		if(device != null)
			devices.push(device);
	}

	return devices;
}


function matchTouchDevice(device, identity){
	if(identity == null)
		return false;
	if(identity.vendorId != null && device.vendorId !== normalizeHexId(identity.vendorId))
		return false;
	if(identity.productId != null && device.productId !== normalizeHexId(identity.productId))
		return false;
	if(identity.serial != null && device.serial !== identity.serial)
		return false;
	if(identity.path != null && device.path !== identity.path)
		return false;
	if(identity.name != null && device.name !== identity.name)
		return false;
	if(identity.uniq != null && device.uniq !== identity.uniq)
		return false;
	if(identity.interfaceNumber != null && device.interfaceNumber !== identity.interfaceNumber)
		return false;
	if(identity.eventPath != null && device.eventPath !== identity.eventPath)
		return false;
	if(identity.byIdPath != null && device.byIdPath !== identity.byIdPath)
		return false;
	if(identity.byPathPath != null && device.byPathPath !== identity.byPathPath)
		return false;
	return true;
}


function getTouchStateFilePath(stateDir){
	return path.join(stateDir, 'touch-mappers.json');
}


async function readTouchState(stateDir){
	let stateFilePath = getTouchStateFilePath(stateDir);
	try{
		let sourceText = await fsp.readFile(stateFilePath, 'utf8');
		let parsed = JSON.parse(sourceText);
		if(Array.isArray(parsed))
			return parsed;
	}catch(err){
		if(err.code === 'ENOENT')
			return [];
		throw err;
	}
	return [];
}


async function writeTouchState(stateDir, value){
	let stateFilePath = getTouchStateFilePath(stateDir);
	await fsp.mkdir(path.dirname(stateFilePath), {recursive: true});
	await fsp.writeFile(stateFilePath, JSON.stringify(value, null, '\t') + '\n', 'utf8');
}


async function clearTouchState(stateDir){
	let stateFilePath = getTouchStateFilePath(stateDir);
	try{
		await fsp.unlink(stateFilePath);
	}catch(err){
		if(err.code !== 'ENOENT')
			throw err;
	}
}


async function stopTouchMappers(stateDir){
	let entries = await readTouchState(stateDir);
	for(let entry of entries){
		if(entry == null || typeof entry.pid !== 'number')
			continue;
		try{
			process.kill(entry.pid, 'SIGTERM');
		}catch(err){
			if(err.code !== 'ESRCH')
				throw err;
		}
	}
	await clearTouchState(stateDir);
}


async function ensureTouchHelperBuilt(){
	let sourceStat = await fsp.stat(helperSourcePath);
	let binaryStat = null;
	try{
		binaryStat = await fsp.stat(helperBinaryPath);
	}catch(err){
		if(err.code !== 'ENOENT')
			throw err;
	}

	if(binaryStat != null && binaryStat.mtimeMs >= sourceStat.mtimeMs)
		return helperBinaryPath;

	await fsp.mkdir(path.dirname(helperBinaryPath), {recursive: true});
	await execFileAsync('cc', [
		'-O2',
		'-Wall',
		'-Wextra',
		'-std=c11',
		'-o',
		helperBinaryPath,
		helperSourcePath,
		'-lm'
	], {
		encoding: 'utf8'
	});
	await fsp.chmod(helperBinaryPath, 0o755);
	return helperBinaryPath;
}


function formatTouchMapperCommand(binaryPath, mapping){
	return [
		binaryPath,
		'--device', mapping.devicePath,
		'--matrix', mapping.matrix.join(' '),
		'--name', mapping.virtualDeviceName
	];
}


async function startTouchMappers(mappings, stateDir){
	await stopTouchMappers(stateDir);
	if(mappings.length === 0)
		return [];

	let binaryPath = await ensureTouchHelperBuilt();
	let started = [];
	for(let mapping of mappings){
		let args = formatTouchMapperCommand(binaryPath, mapping).slice(1);
		let child = spawn(binaryPath, args, {
			detached: true,
			stdio: 'ignore'
		});
		child.unref();
		started.push({
			pid: child.pid,
			devicePath: mapping.devicePath,
			monitorName: mapping.monitorName,
			logicalMonitorName: mapping.logicalMonitorName,
			matrix: mapping.matrix,
			virtualDeviceName: mapping.virtualDeviceName
		});
	}

	await writeTouchState(stateDir, started);
	return started;
}


export {
	ensureTouchHelperBuilt,
	formatTouchMapperCommand,
	getTouchStateFilePath,
	listTouchDevices,
	matchTouchDevice,
	startTouchMappers,
	stopTouchMappers
};
