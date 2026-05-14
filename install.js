import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {xdgConfig} from 'xdg-basedir';


let packageDirPath = path.dirname(fileURLToPath(import.meta.url));
let sourceUnitPath = path.join(packageDirPath, 'kdisplay-manager.service');
let configHomePath = xdgConfig ?? path.join(process.env.HOME, '.config');
let userUnitDirPath = path.join(configHomePath, 'systemd', 'user');
let targetUnitPath = path.join(userUnitDirPath, 'kdisplay-manager.service');


async function ensureUserUnitLink(){
	await fsp.mkdir(userUnitDirPath, {recursive: true});

	try{
		let stat = await fsp.lstat(targetUnitPath);
		if(stat.isSymbolicLink()){
			let existingTargetPath = await fsp.readlink(targetUnitPath);
			let resolvedExistingTargetPath = path.resolve(path.dirname(targetUnitPath), existingTargetPath);
			if(resolvedExistingTargetPath == sourceUnitPath){
				console.log('systemd user unit already linked:', targetUnitPath);
				return;
			}

			await fsp.unlink(targetUnitPath);
		}else{
			throw new Error('Refusing to replace non-symlink systemd user unit: ' + targetUnitPath);
		}
	}catch(err){
		if(err.code != 'ENOENT')
			throw err;
	}

	await fsp.symlink(sourceUnitPath, targetUnitPath);
	console.log('linked systemd user unit:', targetUnitPath);
	console.log('next: systemctl --user daemon-reload');
	console.log('next: systemctl --user enable --now kdisplay-manager.service');
}


ensureUserUnitLink().catch(function(err){
	console.error(err);
	process.exitCode = 1;
});
