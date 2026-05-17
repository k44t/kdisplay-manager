export default {
	'apply-on-config-change': false,
	monitors: {
		capsule: {
			vendor: 'AKR',
			product: 'Capsule 3',
			serial: '0x00000001'
		},
		center: {
			vendor: 'LEN',
			product: 'C27q-35',
			serial: 'URHK8MBR'
		},
		left: {
			vendor: 'LEN',
			product: 'C27q-35',
			serial: 'URHK8XMS'
		},
		right: {
			vendor: 'LEN',
			product: 'C27q-35',
			serial: 'URHK6GDB'
		},
		dasung: {
			vendor: 'DSC',
			product: 'Paperlike103',
			serial: '0x3d1b1b4421'
		},
		intehill: {
			vendor: 'HSJ',
			product: 'U13ZT',
			serial: '000000000001',
			touch: {
				vendorId: '27c6',
				productId: '0529',
				serial: '9LQ0172005164'
			}
		}
	},
	configs: {
		center: {
			mode: '2560x1440',
			'#center': {
				primary: true
			},
			scale: 1
		},
		'3': {
			extends: 'center',
			'#left': {
				'left-of': '#center'
			},
			'#right': {
				'right-of': '#center'
			}
		},
		'left + center + mirror capsule right': {
			extends: '3',
			'#right': {
				monitors: ['right', 'capsule'],
				mode: '1920x1080'
			}
		},
		'center + mirror capsule right': {
			extends: 'left + center + mirror capsule right',
			'#left': {
				enable: false
			}
		},
		'center + right': {
			extends: '3',
			'#left': {
				enable: false
			}
		},
		'3 + intehill below center': {
			extends: '3',
			'#intehill': {
				optional: true,
				below: '#center',
				mode: '1920x1080',
				align: 'center'
			}
		},
		'3 + dasung below center': {
			extends: '3',
			'#dasung': {
				below: '#center',
				mode: '1872x1404',
				align: 'center'
			}
		},
		'left + center + mirror capsule right + intehill below center': {
			extends: 'left + center + mirror capsule right',
			'#intehill': {
				below: '#center',
				monitors: ['intehill', {name: 'dasung', optional: true}],
				mode: '1920x1080',
				offsetX: 330
			}
		}
	}
};
