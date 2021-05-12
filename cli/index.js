#!/usr/bin/env node

const fs = require('fs')

const die = (err, origin) => {
	console.error(`An unhandled exception occured!`)
	console.error(`Exception origin: ${JSON.stringify(origin)}`)
	console.error(err)
	process.exit(1)
}

process.on('uncaughtException', die)
process.on('unhandledRejection', die)

const { run } = require('../dist/run')
run({
	target: process.env.RUN_TARGET ?? 'nrf9160dk_nrf9160ns',
	device: process.env.RUN_DEVICE ?? '/dev/ttyACM0',
})(JSON.parse(fs.readFileSync(0, 'utf-8')))
	.then((res) => {
		if (res.timeout) {
			console.error(`Timed out.`)
			process.exit(-1)
		}
		if (res.abort) {
			console.error('Aborted.')
			process.exit(-2)
		}
		if (!res.connected) {
			console.error('Did not connect.')
			process.exit(-3)
		}
	})
	.catch((err) => {
		console.error(err.message)
		process.exit(-99)
	})
