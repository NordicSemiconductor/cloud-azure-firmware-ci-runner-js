import {
	flash,
	connect,
	flashCredentials,
	allSeen,
	progress,
	warn,
	log,
	runCmd,
	atHostHexfile,
	debug,
} from '@nordicsemiconductor/firmware-ci-device-helpers'
import { promises as fs } from 'fs'
import * as path from 'path'

export const run = async ({
	deviceId,
	appVersion,
	target,
	network,
	secTag,
	timeoutInMinutes,
	hexFile,
	fotaFile,
	abortOn,
	endOn,
	endOnWaitSeconds,
	testEnv,
	certDir,
	powerCycle,
}: {
	deviceId: string
	appVersion: string
	target: 'thingy91_nrf9160ns' | 'nrf9160dk_nrf9160ns'
	network: 'ltem' | 'nbiot'
	secTag: number
	timeoutInMinutes: number
	hexFile: string
	fotaFile: string
	abortOn?: string[]
	endOn?: string[]
	endOnWaitSeconds?: number
	testEnv: {
		credentials: string
		location: string
		resourceGroup: string
		appName: string
	}
	certDir: string
	powerCycle?: {
		offCmd: string
		onCmd: string
		waitSecondsAfterOff: number
		waitSecondsAfterOn: number
	}
}): Promise<{
	connected: boolean
	timeout: boolean
	abort: boolean
	deviceLog: string[]
	flashLog: string[]
}> => {
	debug(deviceId, 'appVersion', appVersion)
	debug(deviceId, 'target', target)
	debug(deviceId, 'network', network)
	debug(deviceId, 'secTag', secTag)
	debug(deviceId, 'timeoutInMinutes', timeoutInMinutes)
	debug(deviceId, 'hexFile', hexFile)
	debug(deviceId, 'fotaFile', fotaFile)
	debug(deviceId, 'abortOn', abortOn)
	debug(deviceId, 'endOn', endOn)
	debug(deviceId, 'endOn wait seconds', endOnWaitSeconds)
	debug(deviceId, 'testEnv', testEnv)
	debug(deviceId, 'certDir', certDir)
	debug(deviceId, 'powerCycle', powerCycle)
	const atHost =
		target === 'thingy91_nrf9160ns'
			? atHostHexfile.thingy91
			: atHostHexfile['9160dk']

	if (powerCycle !== undefined) {
		progress(deviceId, `Power cycling device`)
		progress(deviceId, `Turning off ...`)
		progress(deviceId, powerCycle.offCmd)
		await runCmd({ cmd: powerCycle.offCmd })
		progress(deviceId, `Waiting ${powerCycle.waitSecondsAfterOff} seconds ...`)
		await new Promise((resolve) =>
			setTimeout(resolve, powerCycle.waitSecondsAfterOff * 1000),
		)
		progress(deviceId, `Turning on ...`)
		progress(deviceId, powerCycle.onCmd)
		await runCmd({ cmd: powerCycle.onCmd })

		progress(deviceId, `Waiting ${powerCycle.waitSecondsAfterOn} seconds ...`)
		await new Promise((resolve) =>
			setTimeout(resolve, powerCycle.waitSecondsAfterOn * 1000),
		)
	}

	return new Promise<{
		connected: boolean
		timeout: boolean
		abort: boolean
		deviceLog: string[]
		flashLog: string[]
	}>((resolve, reject) => {
		let done = false
		progress(deviceId, `Connecting...`)
		connect({
			device: deviceId,
			atHostHexfile: atHost,
			...log(),
		})
			.then(async ({ connection, deviceLog, onData, onEnd }) => {
				let flashLog: string[] = []
				const credentials = JSON.parse(
					await fs.readFile(
						path.resolve(certDir, `device-${deviceId}.json`),
						'utf-8',
					),
				)

				progress(deviceId, `Setting timeout to ${timeoutInMinutes} minutes`)
				const jobTimeout = setTimeout(async () => {
					done = true
					warn(deviceId, 'Timeout reached.')
					await connection.end()
					resolve({
						connected: true,
						timeout: true,
						abort: false,
						deviceLog,
						flashLog,
					})
				}, timeoutInMinutes * 60 * 1000)

				onEnd(async (_, timeout) => {
					if (timeout) {
						done = true
						clearTimeout(jobTimeout)
						warn(deviceId, 'Device read timeout occurred.')
						resolve({
							connected: true,
							timeout: true,
							abort: false,
							deviceLog,
							flashLog,
						})
					}
					await flash({
						hexfile: atHost,
						...log('Resetting device with AT Host'),
					})
				})
				progress(deviceId, 'Flashing credentials')
				await flashCredentials({
					...credentials,
					...connection,
					secTag,
				})
				flashLog = await flash({
					hexfile: hexFile,
					...log('Flash Firmware'),
				})

				const terminateOn = (type: 'abortOn' | 'endOn', s: string[]) => {
					progress(
						deviceId,
						`<${type}>`,
						`Setting up ${type} traps. Job will terminate if output contains:`,
					)
					s?.map((s) => progress(deviceId, `<${type}>`, s))
					const terminateCheck = allSeen(s)
					onData(async (data) => {
						s?.forEach(async (s) => {
							if (data.includes(s)) {
								warn(deviceId, `<${type}>`, 'Termination criteria seen:', s)
							}
						})
						if (terminateCheck(data)) {
							if (!done) {
								done = true
								warn(
									deviceId,
									`<${type}>`,
									'All termination criteria have been seen.',
								)
								clearTimeout(jobTimeout)
								if (type === 'endOn')
									await new Promise((resolve) =>
										setTimeout(resolve, (endOnWaitSeconds ?? 60) * 1000),
									)
								await connection.end()
								resolve({
									connected: true,
									abort: false,
									timeout: false,
									deviceLog,
									flashLog,
								})
							}
						}
					})
				}

				if (abortOn !== undefined) terminateOn('abortOn', abortOn)
				if (endOn !== undefined) terminateOn('endOn', endOn)
			})
			.catch(reject)
	})
}
