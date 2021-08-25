import { Registry } from 'azure-iothub'

export const deviceHasConnected = async ({
	deviceId,
	iotHubRegistry,
}: {
	deviceId: string
	iotHubRegistry: Registry
}): Promise<boolean> => {
	const res = await iotHubRegistry
		.createQuery(`SELECT * FROM devices WHERE deviceId='${deviceId}'`)
		.nextAsTwin()
	return res.result.length > 0
}
