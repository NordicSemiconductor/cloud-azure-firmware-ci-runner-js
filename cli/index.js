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
	target: process.env.E2E_RUN_TARGET ?? 'nrf9160dk_nrf9160ns',
	device: process.env.E2E_RUN_DEVICE ?? '/dev/ttyACM0',
})(JSON.parse(fs.readFileSync(0, 'utf-8')))
