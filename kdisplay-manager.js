#!/usr/bin/env node

import argparse from 'argparse';
import {runCli as runDisplayCli} from './display-manager.js';
import {runCli as runServiceCli} from './service.js';


let {ArgumentParser} = argparse;


function createArgumentParser(){
	let parser = new ArgumentParser({
		prog: 'kdisplay-manager',
		description: 'Apply saved display configs or run the display manager service.'
	});
	let subparsers = parser.add_subparsers({
		dest: 'command',
		required: true
	});

	let applyParser = subparsers.add_parser('apply', {
		help: 'apply a saved display config'
	});
	applyParser.add_argument('config_name', {
		help: 'display config name'
	});
	applyParser.add_argument('--dry-run', {
		action: 'store_true',
		help: 'print the gdctl command without applying it'
	});
	applyParser.add_argument('--config-dir', {
		help: 'read display configs from this directory'
	});
	applyParser.add_argument('--state-dir', {
		help: 'read and write state in this directory'
	});

	let listConfigsParser = subparsers.add_parser('list-configs', {
		help: 'list saved display configs'
	});
	listConfigsParser.add_argument('--config-dir', {
		help: 'read display configs from this directory'
	});
	listConfigsParser.add_argument('--state-dir', {
		help: 'read and write state in this directory'
	});
	listConfigsParser.add_argument('--order', {
		choices: ['recent', 'config'],
		default: 'config',
		help: 'order configs by recent use or config file order'
	});
	listConfigsParser.add_argument('--applicable', {
		action: 'store_true',
		help: 'only include configs that match connected displays'
	});
	listConfigsParser.add_argument('--json', {
		action: 'store_true',
		help: 'print configs as JSON'
	});

	let listMonitorsParser = subparsers.add_parser('list-monitors', {
		help: 'list connected monitors'
	});
	listMonitorsParser.add_argument('--config-dir', {
		help: 'read display configs from this directory'
	});
	listMonitorsParser.add_argument('--state-dir', {
		help: 'read and write state in this directory'
	});
	listMonitorsParser.add_argument('--json', {
		action: 'store_true',
		help: 'print monitors as JSON'
	});

	let listTouchDevicesParser = subparsers.add_parser('list-touchscreens', {
		help: 'list connected touch-capable input devices'
	});
	listTouchDevicesParser.add_argument('--config-dir', {
		help: 'read display configs from this directory'
	});
	listTouchDevicesParser.add_argument('--state-dir', {
		help: 'read and write state in this directory'
	});
	listTouchDevicesParser.add_argument('--json', {
		action: 'store_true',
		help: 'print touch devices as JSON'
	});

	let serviceParser = subparsers.add_parser('service', {
		help: 'run the display manager service'
	});
	serviceParser.add_argument('--apply-on-start', {
		action: 'store_true',
		help: 'apply the selected config when the service starts'
	});
	serviceParser.add_argument('--config-dir', {
		help: 'read display configs from this directory'
	});
	serviceParser.add_argument('--state-dir', {
		help: 'read and write state in this directory'
	});

	return parser;
}


function buildApplyArgs(parsed){
	let args = [];
	if(parsed.config_dir != null)
		args.push('--config-dir', parsed.config_dir);
	if(parsed.state_dir != null)
		args.push('--state-dir', parsed.state_dir);
	args.push('apply', parsed.config_name);
	if(parsed.dry_run)
		args.push('--dry-run');
	return args;
}


function buildDisplayArgs(parsed){
	let args = [];
	if(parsed.config_dir != null)
		args.push('--config-dir', parsed.config_dir);
	if(parsed.state_dir != null)
		args.push('--state-dir', parsed.state_dir);
	args.push(parsed.command);
	if(parsed.command == 'list-configs'){
		args.push('--order', parsed.order ?? 'config');
		if(parsed.applicable)
			args.push('--applicable');
		if(parsed.json)
			args.push('--json');
	}
	if(parsed.command == 'list-monitors' || parsed.command == 'list-touchscreens'){
		if(parsed.json)
			args.push('--json');
	}
	return args;
}


function buildServiceArgs(parsed){
	let args = [];
	if(parsed.apply_on_start)
		args.push('--apply-on-start');
	if(parsed.config_dir != null)
		args.push('--config-dir', parsed.config_dir);
	if(parsed.state_dir != null)
		args.push('--state-dir', parsed.state_dir);
	return args;
}


async function main(){
	let parsed = createArgumentParser().parse_args(process.argv.slice(2));

	if(parsed.command == 'apply'){
		await runDisplayCli(buildApplyArgs(parsed));
		return;
	}

	if(parsed.command == 'service'){
		await runServiceCli(buildServiceArgs(parsed));
		return;
	}

	await runDisplayCli(buildDisplayArgs(parsed));
}


main().catch(function(err){
	console.error(err);
	process.exitCode = 1;
});
