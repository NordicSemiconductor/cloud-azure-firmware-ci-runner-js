import { log } from '@nordicsemiconductor/firmware-ci-device-helpers'
import { Registry } from 'azure-iothub'

export const deviceHasConnected = async ({
	deviceId,
	iotHubRegistry,
}: {
	deviceId: string
	iotHubRegistry: Registry
}): Promise<boolean> => {
	const { progress, success, error } = log({
		prefixes: ['connection', deviceId],
	})

	progress(`Checking if device has connected ...`)
	try {
		const device = iotHubRegistry.createQuery(
			`SELECT * FROM devices WHERE deviceId='${deviceId}'`,
		)
		const res = (await device.nextAsTwin()).result[0]
		progress('Device has connected.')
		if (res.properties.reported.dev === undefined) {
			error('Device has not reported device information, yet.')
			return false
		}
		success('Device has connected and reported device information.')
		return true
	} catch (err) {
		console.error(err)
		error('Device has not connected.')
		return false
	}
}
