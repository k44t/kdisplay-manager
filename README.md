# kdisplay-manager

`kdisplay-manager` is a small command-line tool and user service for applying display configurations. Currently it only supports the GNOME desktop environment.

## What It Does

`kdisplay-manager` lets you define named monitor layouts and then:

- apply one explicitly from the command line
- run a background user service that reacts to monitor changes
- remember recently used configurations
- select the best matching config for the currently connected monitors

## Config Selection

When selecting a configuration for application, kdisplay-manager filters through its configurations to find those that could be applied to the currently connected monitors. Then depending on the selection strategy that is configured (default is "most-monitors") a configuration is applied:

- strategy "configuration-order": 
  the first configuration will be applied.
- "most-monitors":
  The applicable list is sorted by the number of connected monitors it matches (preserving configuration file order for those configurations that have the same number of monitors) and filters all configurations that have less than the maximum number. Among the remaining configurations the most recently used configuration will be applied. If none was used recently the first in the list will be applied. 
- strategy "recent":
  Same as "most-monitors" except that the list is not filtered by the number of monitors.


## Install

Install the package globally with npm:

```bash
npm install -g kdisplay-manager
```

This package includes `kdisplay-manager.service` (systemd user service configuration file) and an install helper script. After a global install, run:

```bash
node "$(npm root -g)/kdisplay-manager/install.js"
```

That links the service unit into the user's systemd configuration. After that, reload and enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now kdisplay-manager.service
```

Instead of using the install helper feel free to adapt `kdisplay-manager.service` to your needs.

## Run

The common way to run the service is through the installed `systemd` user unit.

The commands below are for running `kdisplay-manager` manually.

The package installs the `kdisplay-manager` executable.

### Apply a saved config

```bash
kdisplay-manager apply <config_name>
```

Only shows the command that would be run to apply the configuration
instead of actually running it:

```bash
kdisplay-manager apply <config_name> --dry-run
```

Useful options:

```bash
kdisplay-manager apply <config_name> --config-dir /path/to/config
kdisplay-manager apply <config_name> --state-dir /path/to/state
```

### Run the display manager service

For normal use, prefer enabling and starting `kdisplay-manager.service` with `systemd --user` instead of running the service command directly.

Manual usage:

```bash
kdisplay-manager service --apply-on-start
```

Useful options:

```bash
kdisplay-manager service --config-dir /path/to/config
kdisplay-manager service --state-dir /path/to/state
```

## Configuration

By default, the tool looks for its configuration in the user's XDG config directory under:

```text
~/.config/kdisplay-manager/
```

It looks for one of these files:

- `kdisplay-manager.js`
- `kdisplay-manager.json`

An example configuration looks like:

```js
export default {
	'apply-on-config-change': false,
	'selection-strategy': 'most-monitors',
	monitors: {
		center: {vendor: 'LEN', product: 'C27q-35', serial: 'URHK8MBR'},
		left: {vendor: 'LEN', product: 'C27q-35', serial: 'URHK8XMS'},
		right: {vendor: 'LEN', product: 'C27q-35', serial: 'URHK6GDB'},
		portable: {vendor: 'HSJ', product: 'U13ZT', serial: '000000000001'}
	},
	configs: {
		base: {
            // this mode is applied to all monitors within the config,
            // and to all monitors within configs that extend this 
            // config, unless overridden.
			mode: '2560x1440',

            // the same kind of "inheritance is applied to all monitor
            // properties
			scale: 1,
			transform: 'normal',
			colorMode: 'default',
			rgbRange: 'auto',

			'#center': {
				monitors: ['center'],
				primary: true,
				x: 0,
				y: 0
			}
		},
		triple: {
            // inherits all defaults and all monitors from base
			extends: 'base',
			'#left': {
				monitors: ['left'],
				'left-of': '#center',
				align: 'center'
			},
			'#right': {
				monitors: ['right'],
				'right-of': '#center',
				offsetY: 200
			}
		},
		portableBelow: {
			extends: 'triple',
			'#portable': {
				monitors: ['portable'],
				below: '#center',

                // mode with explicit refresh rate
				mode: '1920x1080@60.000',

                // since resolution is smaller than #center
                // aligns the monitor below the #center monitor
				align: 'center'
			}
		},
		centerRightOnly: {
			extends: 'triple',
			'#left': {
                // since centerRightOnly extends triple, but only uses
                // two monitors, we can simply disable the third
				enable: false
			}
		},
		portableAbove: {
			extends: 'base',
			'#portable': {
				monitors: ['portable'],
				above: '#center',
				mode: '1920x1080',
				align: 'center'
			}
		},
		mirroredPresentation: {
			extends: 'base',
			'#presentation': {
				monitors: ['right', 'portable'],
				mode: '1920x1080',
				primary: true,
				x: 0,
				y: 0
			}
		},
		// `rgb-range` and `color-mode` are accepted in kebab-case too.
	}
};
```

The full real-world sample copied from a live setup is in `sample-config.js`.

`selection-strategy` may be `most-monitors`, `recent`, or `configuration-order`. If omitted, the default is `most-monitors`.

## Application State

The service stores recent config state under the user's XDG state directory, typically:

```text
~/.local/state/kdisplay-manager/recent-configs.txt
```

## License

This project is licensed under the MIT License. See `LICENSE`.

## Dependency Licenses

This package depends directly on the following npm packages:

- `argparse` - `Python-2.0`
- `dbus-next` - `MIT`
- `xdg-basedir` - `MIT`

Those dependencies remain under their own licenses. This repository's MIT license applies to `kdisplay-manager` itself, not to third-party packages.

Transitive dependencies may have additional licenses of their own.
