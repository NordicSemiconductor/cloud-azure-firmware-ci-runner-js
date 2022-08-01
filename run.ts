import { AzureCliCredential } from '@azure/identity'
import { BlobServiceClient, BlockBlobUploadResponse } from '@azure/storage-blob'
import {
	allSeen,
	anySeen,
	atHostHexfile,
	connect,
	Connection,
	flash,
	log,
	runCmd,
} from '@nordicsemiconductor/firmware-ci-device-helpers'
import { Registry } from 'azure-iothub'
import { promises as fs } from 'fs'
import * as path from 'path'
import * as semver from 'semver'
import { URL } from 'url'
import { v4 } from 'uuid'
import { exec } from './exec'

type Result = Promise<{
	connected: boolean
	timeout: boolean
	abort: boolean
	deviceLog?: string[]
	flashLog?: string[]
}>

type Args = {
	deviceId: string
	appVersion: string
	network: 'ltem' | 'nbiot'
	secTag: number
	timeoutInMinutes: number
	hexFile: string
	fotaFile: string
	abortOn?: string[]
	endOn?: string[]
	endOnWaitSeconds?: number
	testEnv: {
		appName: string
		storageAccountName: string
	}
	certDir: string
	powerCycle?: {
		offCmd: string
		onCmd: string
		waitSecondsAfterOff: number
		waitSecondsAfterOn: number
	}
	flashLogLocation: string
	deviceLogLocation: string
}

export const run = ({
	port,
	target,
}: {
	port: string
	target: 'thingy91_nrf9160_ns' | 'nrf9160dk_nrf9160_ns'
}): ((args: Args) => Result) => {
	const { debug, progress, warn, error, success } = log()
	debug('port', port)
	debug('target', target)
	return async ({
		deviceId,
		appVersion,
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
		flashLogLocation,
		deviceLogLocation,
	}: Args): Result => {
		debug('appVersion', appVersion)
		debug('network', network)
		debug('secTag', secTag)
		debug('timeoutInMinutes', timeoutInMinutes)
		debug('hexFile', hexFile)
		debug('fotaFile', fotaFile)
		debug('abortOn', abortOn)
		debug('endOn', endOn)
		debug('endOn wait seconds', endOnWaitSeconds)
		debug('testEnv', testEnv)
		debug('certDir', certDir)
		debug('powerCycle', powerCycle)
		debug('flashLogLocation', flashLogLocation)
		debug('deviceLogLocation', deviceLogLocation)
		const atHost =
			target === 'thingy91_nrf9160_ns'
				? atHostHexfile.thingy91
				: atHostHexfile['9160dk']

		const creds = new AzureCliCredential()

		const iotHubRegistry = Registry.fromTokenCredential(
			`${testEnv.appName}IotHub.azure-devices.net`,
			creds,
		)

		const fotaStorageContainer = 'upgrades'
		const blobServiceClient = new BlobServiceClient(
			`https://${testEnv.storageAccountName}.blob.core.windows.net`,
			creds,
		)
		const containerClient =
			blobServiceClient.getContainerClient(fotaStorageContainer)
		const fotaFileName = `${deviceId.slice(0, 8)}.bin`

		if (powerCycle !== undefined) {
			progress(port, `Power cycling device`)
			progress(port, `Turning off ...`)
			progress(port, powerCycle.offCmd)
			await runCmd({ cmd: powerCycle.offCmd })
			progress(port, `Waiting ${powerCycle.waitSecondsAfterOff} seconds ...`)
			await new Promise((resolve) =>
				setTimeout(resolve, powerCycle.waitSecondsAfterOff * 1000),
			)
			progress(port, `Turning on ...`)
			progress(port, powerCycle.onCmd)
			await runCmd({ cmd: powerCycle.onCmd })

			progress(port, `Waiting ${powerCycle.waitSecondsAfterOn} seconds ...`)
			await new Promise((resolve) =>
				setTimeout(resolve, powerCycle.waitSecondsAfterOn * 1000),
			)
		}

		// nrfjprog --eraseall
		await exec({
			cmdWithArgs: ['nrfjprog', '--eraseall'],
			log: (...args) => progress('eraseall', ...args),
			error: (...args) => error('eraseall', ...args),
		})

		let uploadResult: BlockBlobUploadResponse | undefined

		try {
			const res = await new Promise<{
				connected: boolean
				timeout: boolean
				abort: boolean
				deviceLog?: string[]
				flashLog?: string[]
			}>((resolve, reject) => {
				let flashLog: string[] = []
				let done = false
				let connection: Connection
				let schedulaFotaTimeout: NodeJS.Timeout
				let deviceLog: string[]
				let connected = false

				progress(port, `Setting timeout to ${timeoutInMinutes} minutes`)
				const jobTimeout = setTimeout(async () => {
					done = true
					warn(deviceId, 'Timeout reached.')
					await connection?.end()
					if (schedulaFotaTimeout !== undefined)
						clearTimeout(schedulaFotaTimeout)
					resolve({
						connected,
						timeout: true,
						abort: false,
						deviceLog,
						flashLog,
					})
				}, timeoutInMinutes * 60 * 1000)

				progress(port, `Connecting...`)
				connect({
					device: port,
					atHostHexfile: atHost,
					...log(),
					onEnd: async (_, timeout) => {
						if (timeout) {
							done = true
							clearTimeout(jobTimeout)
							if (schedulaFotaTimeout !== undefined)
								clearTimeout(schedulaFotaTimeout)
							warn(deviceId, 'Device read timeout occurred.')
							resolve({
								connected,
								timeout: true,
								abort: false,
								deviceLog,
								flashLog,
							})
						}
						await flash({
							hexfile: atHost,
							...log({ prefixes: ['Resetting device with AT Host'] }),
						})
					},
				})
					.then(async ({ connection: c, deviceLog: d, onData }) => {
						connection = c
						deviceLog = d
						const credentials = JSON.parse(
							await fs.readFile(
								path.resolve(certDir, `device-${deviceId}.json`),
								'utf-8',
							),
						)

						const mfwv = (await connection.at('AT+CGMR'))[0]
						if (mfwv !== undefined) {
							progress(`Firmware version:`, mfwv)
							const v = mfwv.split('_')[2]
							if (semver.satisfies(v, '>=1.3.0')) {
								progress(`Resetting modem settings`, port)
								await connection.at('AT%XFACTORYRESET=0')
							} else {
								warn(`Please update your modem firmware!`)
							}
						}

						progress(port, 'Flashing credentials')
						progress('Provisioning credentials')
						// Turn off modem
						await connection.at('AT+CFUN=4')
						// 0 – Root CA certificate (ASCII text)
						await connection.at(
							`AT%CMNG=0,${secTag},0,"${(
								await fs.readFile(
									path.resolve(
										__dirname,
										'..',
										'data',
										'BaltimoreCyberTrustRoot.pem',
									),
									'utf-8',
								)
							).replace(/\n/g, '\r\n')}"`,
						)
						// 1 – Client certificate (ASCII text)
						await connection.at(
							`AT%CMNG=0,${secTag},1,"${credentials.clientCert.replace(
								/\n/g,
								'\r\n',
							)}"`,
						)
						// 2 – Client private key (ASCII text)
						await connection.at(
							`AT%CMNG=0,${secTag},2,"${credentials.privateKey.replace(
								/\n/g,
								'\r\n',
							)}"`,
						)
						// Turn on modem
						await connection.at('AT+CFUN=1')

						flashLog = await flash({
							hexfile: hexFile,
							...log({ prefixes: ['Flash Firmware'] }),
						})

						const terminateOn = (
							type: 'abortOn' | 'endOn',
							s: string[],
							t: (s: string[]) => (s: string) => boolean,
						) => {
							progress(
								deviceId,
								`<${type}>`,
								`Setting up ${type} traps. Job will terminate if output contains:`,
							)
							s?.map((s) => progress(port, `<${type}>`, s))
							const terminateCheck = t(s)
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
											connected,
											abort: type === 'abortOn',
											timeout: false,
											deviceLog,
											flashLog,
										})
									}
								}
							})
						}

						if (abortOn !== undefined) terminateOn('abortOn', abortOn, anySeen)
						if (endOn !== undefined) terminateOn('endOn', endOn, allSeen)

						// Schedule Firmware update, if device has connected
						const tryScheduleFota = async () => {
							progress(deviceId, 'checking if device has connected')
							const res = await iotHubRegistry
								.createQuery(
									`SELECT * FROM devices WHERE deviceId='${deviceId}'`,
								)
								.nextAsTwin()
							if (res.result.length > 0) {
								success(deviceId, 'device has connected')
								connected = true

								// Upload FOTA file
								const blockBlobClient =
									containerClient.getBlockBlobClient(fotaFileName)
								const file = await fs.readFile(fotaFile)
								uploadResult = await blockBlobClient.upload(file, file.length, {
									blobHTTPHeaders: {
										blobContentType: 'text/octet-stream',
										blobCacheControl: 'public, max-age=31536000',
									},
								})
								const url = new URL(
									`https://${testEnv.storageAccountName}.blob.core.windows.net/${fotaStorageContainer}/${fotaFileName}`,
								)

								// Schedule
								const res = await iotHubRegistry
									.createQuery(
										`SELECT * FROM devices WHERE deviceId='${deviceId}'`,
									)
									.nextAsTwin()
								await iotHubRegistry.updateTwin(
									deviceId,
									{
										properties: {
											desired: {
												firmware: {
													fwVersion: `${appVersion}-upgraded`,
													fwLocation: {
														protocol: url.protocol,
														host: url.hostname,
														path: url.pathname.slice(1), // remove leading slash
													},
													// See https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/include/net/azure_fota.html
													fwFragmentSize: 1800,
													jobId: v4(),
												},
											},
										},
									},
									res.result[0].etag,
								)
								progress(deviceId, `fota scheduled`)
								// Done, do not reschedule
								return
							}
							// Reschedule
							progress(deviceId, 'has not yet connected, rescheduling FOTA')
							schedulaFotaTimeout = setTimeout(tryScheduleFota, 60 * 1000)
						}
						progress(deviceId, 'Scheduling FOTA')
						schedulaFotaTimeout = setTimeout(tryScheduleFota, 60 * 1000)
					})
					.catch(reject)
			})

			// Delete FOTA file
			if (uploadResult !== undefined) {
				await containerClient.deleteBlob(fotaFileName)
			}

			await Promise.all([
				fs.writeFile(flashLogLocation, res.flashLog?.join('\n') ?? '', 'utf-8'),
				fs.writeFile(
					deviceLogLocation,
					res.deviceLog?.join('\n') ?? '',
					'utf-8',
				),
			])

			return res
		} catch (error) {
			console.error(error)
			process.exit(-1)
		}
	}
}
