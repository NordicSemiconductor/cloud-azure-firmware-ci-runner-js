import { Registry } from 'azure-iothub'
import { v4 } from 'uuid'
import * as nodeurl from 'url'

export const schedulaFOTA = async ({
	deviceId,
	iotHubRegistry,
	appVersion,
	url,
}: {
	deviceId: string
	iotHubRegistry: Registry
	appVersion: string
	url: string
}) => {
	const device = iotHubRegistry.createQuery(
		`SELECT * FROM devices WHERE deviceId='${deviceId}'`,
	)
	const res = await device.nextAsTwin()
	const parsed = nodeurl.parse(url)
	await iotHubRegistry.updateTwin(
		deviceId,
		{
			properties: {
				desired: {
					firmware: {
						fwVersion: appVersion,
						fwLocation: {
							...parsed,
							path: parsed.path?.substr(1), // Remove leading slash
						},
						fwFragmentSize: 1800,
						jobId: v4(),
					},
				},
			},
		},
		res.result[0].etag,
	)
}
